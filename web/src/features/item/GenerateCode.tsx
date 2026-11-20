import { useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cpu, Sparkles } from 'lucide-react';
import { api } from '../../api/client';
import { qk, useMeta } from '../../api/queries';
import type { AiCodeRequest, AiCodeResponse, CodeCheck, GenerationUsage, List, ProblemInterface, TestCase } from '../../api/types';
import { plural, type Tone } from '../../lib/format';
import { checkedCode, codeLanguages, codeRequestFromForm, codeToReplace, currentRunnerChecks, withGeneratedCode, type CheckedCode } from '../../lib/generateCode';
import type { ItemFormState } from '../../lib/itemForm';
import { languageName } from '../../lib/languages';
import { Button } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Callout, ErrorCallout } from '../../ui/misc';
import { MenuButton } from '../../ui/Popover';
import { modelOptions, useProviderChoice, type ProviderChoice } from '../capture/ModelPicker';
import { GeneratingPanel, UsageLine } from '../capture/parts';
import { useScreenJob } from '../jobs/useScreenJob';

const names = (languages: readonly string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(languages.map(languageName));

/** What came back from a generation, for the line under the code section's heading. */
interface Outcome {
  face: ProblemInterface;
  asked: string[];
  got: string[];
  check: CodeCheck | null;
  usage: GenerationUsage;
}

/** The outcome in a line: what was written, what was not, and how the runners did. */
function describeOutcome(o: Outcome, judgeOn: boolean): { tone: Tone; text: string } {
  const missing = o.asked.filter((l) => !o.got.includes(l));
  const parts = [`Wrote ${o.face === 'function' ? 'stubs and runners' : 'starter code'} for ${plural(o.got.length, 'language')}.`];
  if (missing.length > 0) parts.push(`No code came back for ${names(missing)}.`);
  let warn = missing.length > 0;
  if (o.check && !o.check.attempted) parts.push(judgeOn ? 'Runners not checked: no sample test case.' : 'Runners not checked: no judge engine.');
  if (o.check?.attempted) {
    const tried = o.check.runners.filter((r) => r.status !== 'skipped');
    const ran = tried.filter((r) => r.status === 'ok').length;
    if (tried.length > 0) parts.push(ran === tried.length ? `${tried.length === 1 ? 'The runner' : `All ${tried.length} runners`} ran.` : `${ran} of ${plural(tried.length, 'runner')} ran.`);
    warn ||= ran < tried.length;
  }
  return { tone: warn ? 'warn' : 'ok', text: parts.join(' ') };
}

/** A finished generation from an earlier visit, offered rather than applied: the form it was asked from is gone. */
interface Offer {
  jobId: string;
  result: AiCodeResponse;
  request: AiCodeRequest;
}

/**
 * "Generate code" in the code section of the problem editor: the AI writes
 * the code of the languages the tabs list, from the form as it stands, and
 * it goes into the form, so nothing is saved until the form is. Code of the
 * user's own is replaced only after a confirm. For a "solution only"
 * problem each runner is checked on the first sample, and the tabs show it
 * while their code is as generated. The generation is a job on the server:
 * one that finishes after the page was left is offered on return, not
 * applied, since the form it was asked from is gone.
 */
export function useGenerateCode({ form, setForm, itemId }: { form: ItemFormState; setForm: Dispatch<SetStateAction<ItemFormState>>; itemId: string }) {
  const qc = useQueryClient();
  const meta = useMeta().data;
  const aiEnabled = meta?.ai.enabled ?? false;
  const judgeOn = meta?.judge.enabled ?? false;
  const confirm = useConfirm();
  const [checked, setChecked] = useState<CheckedCode | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [asked, setAsked] = useState(0);
  const origin = `/items/${itemId}/edit`;

  const apply = (res: AiCodeResponse, request: Pick<AiCodeRequest, 'interface' | 'languages'>) => {
    const face = request.interface;
    setForm((f) => withGeneratedCode(f, res, face));
    setChecked(face === 'function' ? checkedCode(res) : null);
    setOutcome({ face, asked: request.languages, got: Object.keys(res.starterCode), check: res.check, usage: res.usage });
  };

  const generation = useScreenJob<AiCodeResponse>({
    kind: 'code',
    itemId,
    origin,
    onResult: ({ result, startedHere, job }) => {
      const request = job.request as AiCodeRequest;
      if (startedHere) {
        apply(result, request);
        return true;
      }
      setOffer({ jobId: job.id, result, request });
      return false;
    },
  });
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>(undefined);
  const provider = useProviderChoice(providerChoice, generation.error);
  const languages = codeLanguages(form);
  const models = modelOptions(provider.settings);
  const model = models.find((m) => m.value === provider.value);

  const generate = async () => {
    const replaced = codeToReplace(form);
    if (replaced.length > 0) {
      const ok = await confirm({ title: 'Replace the code?', body: `Your code for ${names(replaced)} is replaced.`, confirmLabel: 'Replace' });
      if (!ok) return;
    }
    setOutcome(null);
    setOffer(null);
    setAsked(languages.length);
    await generation.start(async () => {
      // Not through the query cache: leaving the page would cancel that load, and the request with it.
      const cases = qc.getQueryData<List<TestCase>>(qk.testCases(itemId)) ?? (await api.testCases.list(itemId));
      const samples = cases.items.filter((c) => c.isSample);
      return api.ai.code({ ...codeRequestFromForm(form, samples, itemId), ...provider.request, origin });
    });
  };

  const applyOffer = async () => {
    if (!offer) return;
    const replaced = codeToReplace(form);
    if (replaced.length > 0) {
      const ok = await confirm({ title: 'Replace the code?', body: `Your code for ${names(replaced)} is replaced.`, confirmLabel: 'Replace' });
      if (!ok) return;
    }
    apply(offer.result, offer.request);
    setOffer(null);
    void generation.collect(offer.jobId);
  };

  const declineOffer = () => {
    if (!offer) return;
    setOffer(null);
    void generation.collect(offer.jobId);
  };

  const tools = aiEnabled && (
    <>
      {/* The model is chosen from a menu here: the section's row has no room for a picker. */}
      {models.length > 1 && (
        <MenuButton
          size="sm"
          variant="ghost"
          icon={<Cpu size={14} />}
          label={`Model: ${model?.label ?? 'default'}`}
          menuLabel="Model"
          align="end"
          disabled={generation.running}
          items={[{ heading: 'Model' }, ...models.map((m) => ({ label: m.label, selected: m.value === provider.value, onSelect: () => setProviderChoice(m.value) }))]}
        />
      )}
      <Button
        size="sm"
        icon={<Sparkles size={14} />}
        onClick={() => void generate()}
        busy={generation.running}
        disabled={languages.length === 0}
        title={languages.length === 0 ? 'Add a language first' : undefined}
      >
        Generate code
      </Button>
    </>
  );

  const result = outcome && describeOutcome(outcome, judgeOn);
  const notice = generation.running ? (
    <GeneratingPanel title={asked > 0 ? `Writing code for ${plural(asked, 'language')}…` : 'Writing code…'} startedAt={generation.startedAt} onCancel={() => void generation.cancel()}>
      The tabs stay as they are until it arrives.
    </GeneratingPanel>
  ) : generation.error != null ? (
    <ErrorCallout error={generation.error} title="Code generation failed" onRetry={() => void generate()} />
  ) : offer ? (
    <Callout
      tone="info"
      title="Generated code is ready"
      actions={
        <>
          <Button size="sm" variant="primary" icon={<Sparkles size={14} />} onClick={() => void applyOffer()}>
            Apply generated code
          </Button>
          <Button size="sm" variant="ghost" onClick={declineOffer}>
            Dismiss
          </Button>
        </>
      }
    >
      It was written for {names(offer.request.languages)} while you were away.
    </Callout>
  ) : result ? (
    <div className="code-result">
      <p className={`check-line tone-${result.tone}`} role="status">
        {result.text}
      </p>
      <UsageLine usage={outcome.usage} newTab />
    </div>
  ) : null;

  return {
    tools,
    notice: notice && <div className="case-notice">{notice}</div>,
    runnerResults: checked ? currentRunnerChecks(form, checked) : undefined,
  };
}

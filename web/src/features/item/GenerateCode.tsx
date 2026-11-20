import { useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cpu, Sparkles } from 'lucide-react';
import { api } from '../../api/client';
import { testCasesQuery, useMeta } from '../../api/queries';
import type { CodeCheck, GenerationUsage, ProblemInterface } from '../../api/types';
import { plural, type Tone } from '../../lib/format';
import { checkedCode, codeLanguages, codeRequestFromForm, codeToReplace, currentRunnerChecks, withGeneratedCode, type CheckedCode } from '../../lib/generateCode';
import type { ItemFormState } from '../../lib/itemForm';
import { languageName } from '../../lib/languages';
import { Button } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { ErrorCallout } from '../../ui/misc';
import { MenuButton } from '../../ui/Popover';
import { modelOptions, useProviderChoice, type ProviderChoice } from '../capture/ModelPicker';
import { GeneratingPanel, UsageLine } from '../capture/parts';
import { useGeneration } from '../capture/useGeneration';

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

/**
 * "Generate code" in the code section of the problem editor: the AI writes
 * the code of the languages the tabs list, from the form as it stands, and
 * it goes into the form, so nothing is saved until the form is. Code of the
 * user's own is replaced only after a confirm. For a "solution only"
 * problem each runner is checked on the first sample, and the tabs show it
 * while their code is as generated.
 */
export function useGenerateCode({ form, setForm, itemId }: { form: ItemFormState; setForm: Dispatch<SetStateAction<ItemFormState>>; itemId: string }) {
  const qc = useQueryClient();
  const meta = useMeta().data;
  const aiEnabled = meta?.ai.enabled ?? false;
  const judgeOn = meta?.judge.enabled ?? false;
  const confirm = useConfirm();
  const generation = useGeneration();
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>(undefined);
  const provider = useProviderChoice(providerChoice, generation.error);
  const [checked, setChecked] = useState<CheckedCode | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [asked, setAsked] = useState(0);
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
    setAsked(languages.length);
    const face = form.interface;
    const res = await generation.run(async (signal) => {
      const cases = await qc.ensureQueryData(testCasesQuery(itemId));
      const samples = cases.items.filter((c) => c.isSample);
      return api.ai.code({ ...codeRequestFromForm(form, samples, itemId), ...provider.request }, signal);
    });
    if (!res) return;
    setForm((f) => withGeneratedCode(f, res, face));
    setChecked(face === 'function' ? checkedCode(res) : null);
    setOutcome({ face, asked: languages, got: Object.keys(res.starterCode), check: res.check, usage: res.usage });
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
    <GeneratingPanel title={`Writing code for ${plural(asked, 'language')}…`} startedAt={generation.startedAt} onCancel={generation.cancel}>
      The tabs stay as they are until it arrives.
    </GeneratingPanel>
  ) : generation.error != null ? (
    <ErrorCallout error={generation.error} title="Code generation failed" onRetry={() => void generate()} />
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

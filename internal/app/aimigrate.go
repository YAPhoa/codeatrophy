package app

import (
	"context"
	"fmt"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Settings keys of the single per-kind AI configuration that saved
// providers replaced.
const legacyActiveProvider = "ai.active_provider"

func legacyKey(kind, field string) string { return "ai." + kind + "." + field }

var legacyFields = []string{"model", "base_url", "api_key", "api_key_origin"}

// migrateLegacyAISettings carries the per-kind AI settings of earlier
// versions over into saved providers, once: every kind with anything saved
// becomes a provider named after the kind, and the previously active kind
// becomes the default. It runs in one transaction and removes the old
// settings, so it is idempotent.
//
// Those settings were merged with the environment, which only the server
// knows, so this is done here rather than in a SQL migration: a model or
// base URL that came from the environment is written into the provider,
// which then works as before on its own. Stored keys are carried over as
// they are; their encryption is bound to the kind and origin, which do not
// change, so even a key that cannot be decrypted now (the secret key is
// missing) is kept and works again once the secret key is restored.
func (a *App) migrateLegacyAISettings(ctx context.Context) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		migrated := map[string]string{} // kind -> provider id
		for _, kind := range ai.ProviderIDs {
			vals := map[string]string{}
			for _, f := range legacyFields {
				v, ok, err := tx.GetSetting(legacyKey(kind, f))
				if err != nil {
					return err
				}
				if ok {
					vals[f] = v
				}
			}
			if len(vals) == 0 {
				continue
			}
			for _, f := range legacyFields {
				if err := tx.DeleteSetting(legacyKey(kind, f)); err != nil {
					return err
				}
			}
			if vals["model"] == "" && vals["base_url"] == "" && vals["api_key"] == "" {
				continue
			}
			envModel, envBase, envKey := a.envFor(kind)
			now := a.clock()
			r := store.AIProvider{ID: newID(), Kind: kind, Model: vals["model"], BaseURL: vals["base_url"],
				APIKey: vals["api_key"], Effort: formerEffort(kind), CreatedAt: now, UpdatedAt: now}
			if r.Model == "" {
				r.Model = envModel
			}
			if r.BaseURL == "" {
				r.BaseURL = envBase
			}
			if r.APIKey != "" {
				r.APIKeyOrigin = vals["api_key_origin"]
			}
			name, err := freeProviderName(tx, kindNames[kind])
			if err != nil {
				return err
			}
			r.Name = name
			if err := tx.InsertAIProvider(&r); err != nil {
				return err
			}
			migrated[kind] = r.ID
			a.log.Info("carried saved AI settings over into a provider", "provider", r.Name, "kind", kind)
			switch {
			case r.APIKey == "" && envKey != "":
				a.log.Warn("the key this provider used came from the environment, which is now a separate provider; "+
					"enter the key in the provider or choose the environment provider as the default",
					"provider", r.Name, "environmentProvider", envProviderIDs[kind])
			case r.APIKey != "":
				if _, err := a.secrets.DecryptBound(r.APIKey, keyContext(kind, r.APIKeyOrigin)); err != nil {
					a.log.Warn("the provider's saved API key cannot be decrypted with the current secret key; "+
						"it is kept, and works again if the original secret key is restored", "provider", r.Name)
				} else if r.APIKeyOrigin != originOf(a.effectiveBase(kind, r.BaseURL)) {
					a.log.Warn("the provider's saved API key belongs to another base URL and is not used", "provider", r.Name)
				}
			}
		}
		active, ok, err := tx.GetSetting(legacyActiveProvider)
		if err != nil || !ok {
			return err
		}
		def := ""
		if active != "" {
			if def = migrated[active]; def == "" {
				def = envProviderIDs[active]
			}
		}
		if err := tx.SetSetting(keyDefaultProvider, def); err != nil {
			return err
		}
		return tx.DeleteSetting(legacyActiveProvider)
	})
}

// freeProviderName returns name, or name with a number appended when a
// saved provider already has it.
func freeProviderName(tx store.Tx, name string) (string, error) {
	all, err := tx.ListAIProviders()
	if err != nil {
		return "", err
	}
	taken := map[string]bool{}
	for _, p := range all {
		taken[domain.AIProviderNameKey(p.Name)] = true
	}
	candidate := name
	for i := 2; taken[domain.AIProviderNameKey(candidate)]; i++ {
		candidate = fmt.Sprintf("%s %d", name, i)
	}
	return candidate, nil
}

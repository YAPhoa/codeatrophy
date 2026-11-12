package app

import (
	"context"
	"fmt"
	"strings"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// ListStylePresets lists presets, default first, then by name.
func (a *App) ListStylePresets(ctx context.Context) (List[domain.StylePreset], error) {
	var out List[domain.StylePreset]
	err := a.store.Read(ctx, func(tx store.Tx) error {
		ps, err := tx.ListStylePresets()
		out.Items = ps
		return err
	})
	return out, err
}

// GetStylePreset returns one preset.
func (a *App) GetStylePreset(ctx context.Context, id string) (domain.StylePreset, error) {
	var out domain.StylePreset
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		out, err = tx.GetStylePreset(id)
		return notFoundAs(err, "style preset")
	})
	return out, err
}

func checkStyleName(tx store.Tx, p *domain.StylePreset) error {
	all, err := tx.ListStylePresets()
	if err != nil {
		return err
	}
	for _, o := range all {
		if o.ID != p.ID && strings.EqualFold(o.Name, p.Name) {
			return errField("name", "a style preset with this name already exists")
		}
	}
	return nil
}

// CreateStylePreset creates a preset. The limits are fixed: see
// domain.MaxStylePresets and friends.
func (a *App) CreateStylePreset(ctx context.Context, in domain.StylePresetInput) (domain.StylePreset, error) {
	now := a.clock()
	p := domain.StylePreset{ID: newID(), CreatedAt: now, UpdatedAt: now}
	fe := domain.FieldErrors{}
	if !in.Name.HasValue() {
		fe.Add("name", "is required")
	}
	if !in.Instructions.HasValue() {
		fe.Add("instructions", "is required")
	}
	if in.IsDefault.Set && in.IsDefault.Null {
		fe.Add("isDefault", "cannot be null")
	}
	p.Name, p.Instructions, p.IsDefault = in.Name.Val, in.Instructions.Val, in.IsDefault.Val
	fe.Merge("", domain.ValidateStylePreset(&p))
	if err := errValidation(fe); err != nil {
		return p, err
	}
	err := a.store.Write(ctx, func(tx store.Tx) error {
		all, err := tx.ListStylePresets()
		if err != nil {
			return err
		}
		if len(all) >= domain.MaxStylePresets {
			return errConflict(fmt.Sprintf("at most %d style presets can be kept", domain.MaxStylePresets), nil)
		}
		if err := checkStyleName(tx, &p); err != nil {
			return err
		}
		if p.IsDefault {
			if err := tx.ClearDefaultStylePreset(); err != nil {
				return err
			}
		}
		return tx.InsertStylePreset(&p)
	})
	return p, err
}

// UpdateStylePreset changes a preset's name, instructions or default flag.
func (a *App) UpdateStylePreset(ctx context.Context, id string, in domain.StylePresetInput) (domain.StylePreset, error) {
	var out domain.StylePreset
	err := a.store.Write(ctx, func(tx store.Tx) error {
		p, err := tx.GetStylePreset(id)
		if err != nil {
			return notFoundAs(err, "style preset")
		}
		fe := domain.FieldErrors{}
		if in.Name.Set {
			if in.Name.Null {
				fe.Add("name", "cannot be null")
			}
			p.Name = in.Name.Val
		}
		if in.Instructions.Set {
			if in.Instructions.Null {
				fe.Add("instructions", "cannot be null")
			}
			p.Instructions = in.Instructions.Val
		}
		if in.IsDefault.Set {
			if in.IsDefault.Null {
				fe.Add("isDefault", "cannot be null")
			}
			p.IsDefault = in.IsDefault.Val
		}
		fe.Merge("", domain.ValidateStylePreset(&p))
		if err := errValidation(fe); err != nil {
			return err
		}
		if err := checkStyleName(tx, &p); err != nil {
			return err
		}
		if p.IsDefault {
			if err := tx.ClearDefaultStylePreset(); err != nil {
				return err
			}
		}
		p.UpdatedAt = a.clock()
		if err := tx.UpdateStylePreset(&p); err != nil {
			return err
		}
		out = p
		return nil
	})
	return out, err
}

// DeleteStylePreset deletes a preset. Deleting the default leaves no default.
func (a *App) DeleteStylePreset(ctx context.Context, id string) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		return notFoundAs(tx.DeleteStylePreset(id), "style preset")
	})
}

// DefaultStylePreset returns the default preset, or nil.
func (a *App) DefaultStylePreset(ctx context.Context) (*domain.StylePreset, error) {
	list, err := a.ListStylePresets(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range list.Items {
		if p.IsDefault {
			return &p, nil
		}
	}
	return nil, nil
}

// FindStylePreset looks a preset up by id or, case-insensitively, by name.
func (a *App) FindStylePreset(ctx context.Context, idOrName string) (*domain.StylePreset, error) {
	list, err := a.ListStylePresets(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range list.Items {
		if p.ID == idOrName {
			return &p, nil
		}
	}
	for _, p := range list.Items {
		if strings.EqualFold(p.Name, strings.TrimSpace(idOrName)) {
			return &p, nil
		}
	}
	return nil, errNotFound("style preset")
}

// resolveStyle picks the preset for a generation: omitted means the default
// (if any), null means none, an id means that preset.
func (a *App) resolveStyle(ctx context.Context, styleID domain.Opt[string]) (*domain.StylePreset, error) {
	if !styleID.Set {
		return a.DefaultStylePreset(ctx)
	}
	if styleID.Null {
		return nil, nil
	}
	p, err := a.GetStylePreset(ctx, styleID.Val)
	if err != nil {
		if AsError(err).Code == CodeNotFound {
			return nil, errField("styleId", "style preset does not exist")
		}
		return nil, err
	}
	return &p, nil
}

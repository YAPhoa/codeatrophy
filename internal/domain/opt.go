package domain

import (
	"bytes"
	"encoding/json"
)

// Opt is a JSON field that distinguishes "omitted", "null" and a value, as
// needed for merge-semantics updates.
type Opt[T any] struct {
	Set  bool // the field was present
	Null bool // the field was present and null
	Val  T
}

// Some returns a present, non-null Opt.
func Some[T any](v T) Opt[T] { return Opt[T]{Set: true, Val: v} }

// Null returns a present, null Opt.
func Null[T any]() Opt[T] { return Opt[T]{Set: true, Null: true} }

// UnmarshalJSON implements json.Unmarshaler.
func (o *Opt[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		o.Null = true
		var zero T
		o.Val = zero
		return nil
	}
	o.Null = false
	return json.Unmarshal(b, &o.Val)
}

// MarshalJSON implements json.Marshaler. An unset or null Opt encodes as null.
func (o Opt[T]) MarshalJSON() ([]byte, error) {
	if !o.Set || o.Null {
		return []byte("null"), nil
	}
	return json.Marshal(o.Val)
}

// HasValue reports whether the field was present with a non-null value.
func (o Opt[T]) HasValue() bool { return o.Set && !o.Null }

// Ptr returns a pointer to the value, or nil when unset or null.
func (o Opt[T]) Ptr() *T {
	if !o.HasValue() {
		return nil
	}
	v := o.Val
	return &v
}

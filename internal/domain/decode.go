package domain

import (
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
)

// TypeError reports a JSON value of the wrong type at a field path.
type TypeError struct {
	Path     string // dotted path, e.g. "problem.timeLimitMs"; "" for the top level
	Expected string // "a string", "an object", ...
}

func (e *TypeError) Error() string {
	if e.Path == "" {
		return "the request body must be " + e.Expected
	}
	return e.Path + " must be " + e.Expected
}

// DecodeJSON unmarshals data into v. Type mismatches are reported as
// *TypeError with the path of the offending field, including fields decoded
// by custom unmarshalers such as Opt, for which encoding/json reports no
// path. Other errors are returned as is.
func DecodeJSON(data []byte, v any) error {
	err := json.Unmarshal(data, v)
	if err == nil {
		return nil
	}
	var te *json.UnmarshalTypeError
	if !errors.As(err, &te) {
		return err
	}
	t := reflect.TypeOf(v)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	path, kind := locate(data, t)
	if path == "" && te.Field != "" {
		path = te.Field
	}
	if kind == nil {
		kind = te.Type
	}
	return &TypeError{Path: path, Expected: describeKind(kind)}
}

// locate finds the first field of data that does not decode into t.
func locate(data []byte, t reflect.Type) (string, reflect.Type) {
	t = unwrapOpt(t)
	if t.Kind() == reflect.Slice {
		var elems []json.RawMessage
		if json.Unmarshal(data, &elems) != nil {
			return "", t
		}
		for i, e := range elems {
			if err := json.Unmarshal(e, reflect.New(t.Elem()).Interface()); err != nil {
				sub, kind := locate(e, t.Elem())
				if sub == "" {
					return strconv.Itoa(i), kind
				}
				return strconv.Itoa(i) + "." + sub, kind
			}
		}
		return "", t
	}
	if t.Kind() != reflect.Struct || reflect.PointerTo(t).Implements(unmarshalerType) {
		return "", t
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(data, &obj) != nil {
		return "", t
	}
	for name, ft := range jsonFields(t) {
		raw, ok := obj[name]
		if !ok {
			continue
		}
		if err := json.Unmarshal(raw, reflect.New(ft).Interface()); err != nil {
			sub, kind := locate(raw, ft)
			if sub == "" {
				return name, kind
			}
			return name + "." + sub, kind
		}
	}
	return "", t
}

var unmarshalerType = reflect.TypeFor[json.Unmarshaler]()

// unwrapOpt returns T for Opt[T] (and pointers), otherwise t.
func unwrapOpt(t reflect.Type) reflect.Type {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() == reflect.Struct && strings.HasPrefix(t.Name(), "Opt[") {
		if f, ok := t.FieldByName("Val"); ok {
			return unwrapOpt(f.Type)
		}
	}
	return t
}

// jsonFields maps JSON names to field types, flattening embedded structs.
func jsonFields(t reflect.Type) map[string]reflect.Type {
	out := map[string]reflect.Type{}
	for i := range t.NumField() {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name == "-" {
			continue
		}
		if f.Anonymous && name == "" && f.Type.Kind() == reflect.Struct {
			for k, v := range jsonFields(f.Type) {
				if _, exists := out[k]; !exists {
					out[k] = v
				}
			}
			continue
		}
		if !f.IsExported() {
			continue
		}
		if name == "" {
			name = f.Name
		}
		out[name] = f.Type
	}
	return out
}

func describeKind(t reflect.Type) string {
	if t == nil {
		return "of a different type"
	}
	t = unwrapOpt(t)
	switch t.Kind() {
	case reflect.String:
		return "a string"
	case reflect.Bool:
		return "a boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "an integer"
	case reflect.Float32, reflect.Float64:
		return "a number"
	case reflect.Slice, reflect.Array:
		return "an array"
	case reflect.Map, reflect.Struct:
		return "an object"
	}
	return "of a different type"
}

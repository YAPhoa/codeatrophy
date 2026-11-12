package app

import (
	"errors"
	"fmt"

	"codeathropy/internal/domain"
	"codeathropy/internal/store"
)

// Code is a machine-readable error code shared by every transport.
type Code string

// Error codes. Their HTTP mapping is documented in docs/api.md.
const (
	CodeBadRequest       Code = "bad_request"
	CodeForbidden        Code = "forbidden"
	CodeNotFound         Code = "not_found"
	CodeConflict         Code = "conflict"
	CodeTooLarge         Code = "too_large"
	CodeValidation       Code = "validation_failed"
	CodeUpstream         Code = "upstream_error"
	CodeAIUnavailable    Code = "ai_unavailable"
	CodeJudgeUnavailable Code = "judge_unavailable"
	CodeInternal         Code = "internal"
)

// Error is an application error with a code, a safe message and, for
// validation failures and conflicts, per-field details.
type Error struct {
	Code    Code
	Message string
	Fields  map[string]any
}

func (e *Error) Error() string { return e.Message }

// AsError converts any error into an *Error. Unknown errors become
// CodeInternal with a generic message.
func AsError(err error) *Error {
	var ae *Error
	if errors.As(err, &ae) {
		return ae
	}
	if errors.Is(err, store.ErrNotFound) {
		return &Error{Code: CodeNotFound, Message: "not found"}
	}
	return &Error{Code: CodeInternal, Message: "internal server error"}
}

func errNotFound(what string) error {
	return &Error{Code: CodeNotFound, Message: what + " not found"}
}

func errBadRequest(format string, args ...any) error {
	return &Error{Code: CodeBadRequest, Message: fmt.Sprintf(format, args...)}
}

func errConflict(msg string, fields map[string]any) error {
	return &Error{Code: CodeConflict, Message: msg, Fields: fields}
}

// errValidation builds a validation error from field errors; it returns nil
// when there are none.
func errValidation(fe domain.FieldErrors) error {
	if len(fe) == 0 {
		return nil
	}
	fields := make(map[string]any, len(fe))
	for k, v := range fe {
		fields[k] = v
	}
	return &Error{Code: CodeValidation, Message: fe.First(), Fields: fields}
}

func errField(field, msg string) error {
	return errValidation(domain.FieldErrors{field: msg})
}

// notFoundAs maps store.ErrNotFound to a not-found error for what.
func notFoundAs(err error, what string) error {
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound(what)
	}
	return err
}

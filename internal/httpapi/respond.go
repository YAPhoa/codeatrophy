// Package httpapi is the REST adapter: routing, request decoding and
// response encoding over the application services. It contains no business
// rules.
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

// maxJSONBody bounds JSON request bodies.
const maxJSONBody = domain.MaxRequestBytes

var statusByCode = map[app.Code]int{
	app.CodeBadRequest:       http.StatusBadRequest,
	app.CodeForbidden:        http.StatusForbidden,
	app.CodeNotFound:         http.StatusNotFound,
	app.CodeConflict:         http.StatusConflict,
	app.CodeTooLarge:         http.StatusRequestEntityTooLarge,
	app.CodeValidation:       http.StatusUnprocessableEntity,
	app.CodeUpstream:         http.StatusBadGateway,
	app.CodeAIUnavailable:    http.StatusServiceUnavailable,
	app.CodeJudgeUnavailable: http.StatusServiceUnavailable,
	app.CodeInternal:         http.StatusInternalServerError,
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    app.Code       `json:"code"`
	Message string         `json:"message"`
	Fields  map[string]any `json:"fields,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		http.Error(w, `{"error":{"code":"internal","message":"encoding failed"}}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

// statusClientClosed records a request whose client went away before it was
// answered (nobody receives the response).
const statusClientClosed = 499

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		s.log.Debug("request canceled by the client", "method", r.Method, "path", r.URL.Path)
		w.WriteHeader(statusClientClosed)
		return
	}
	ae := app.AsError(err)
	if ae.Code == app.CodeInternal {
		s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err)
	}
	status, ok := statusByCode[ae.Code]
	if !ok {
		status = http.StatusInternalServerError
	}
	d := errorDetail{Code: ae.Code, Message: ae.Message}
	if ae.Code == app.CodeValidation || (ae.Code == app.CodeConflict && len(ae.Fields) > 0) {
		d.Fields = ae.Fields
		if d.Fields == nil {
			d.Fields = map[string]any{}
		}
	}
	writeJSON(w, status, errorBody{Error: d})
}

func apiError(code app.Code, format string, args ...any) error {
	return &app.Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// decode reads a JSON body into v. An empty body decodes as {}.
func decode(r *http.Request, v any) error {
	body := http.MaxBytesReader(nil, r.Body, maxJSONBody)
	data, err := io.ReadAll(body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return apiError(app.CodeTooLarge, "request body exceeds %d bytes", maxJSONBody)
		}
		return apiError(app.CodeBadRequest, "could not read the request body")
	}
	if len(bytes.TrimSpace(data)) == 0 {
		data = []byte("{}")
	}
	if err := domain.DecodeJSON(data, v); err != nil {
		return decodeError(err)
	}
	return nil
}

// decodeError maps a JSON decoding error to an API error.
func decodeError(err error) error {
	var te *domain.TypeError
	if errors.As(err, &te) {
		if te.Path == "" {
			return apiError(app.CodeBadRequest, "%s", te.Error())
		}
		return &app.Error{Code: app.CodeValidation, Message: te.Error(),
			Fields: map[string]any{te.Path: "must be " + te.Expected}}
	}
	return apiError(app.CodeBadRequest, "malformed JSON: %v", err)
}

// Query helpers.

func queryInt(r *http.Request, name string) (*int, error) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return nil, apiError(app.CodeBadRequest, "%s must be an integer", name)
	}
	return &n, nil
}

func queryBool(r *http.Request, name string) (*bool, error) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return nil, nil
	}
	switch strings.ToLower(v) {
	case "true", "1":
		b := true
		return &b, nil
	case "false", "0":
		b := false
		return &b, nil
	}
	return nil, apiError(app.CodeBadRequest, "%s must be true or false", name)
}

func queryList(r *http.Request, name string) []string {
	var out []string
	for _, v := range r.URL.Query()[name] {
		for _, part := range strings.Split(v, ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

// statusRecorder captures the response status for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

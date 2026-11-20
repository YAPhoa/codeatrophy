package aitest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"codeatrophy/internal/ai"
)

// ModelListService describes how a provider's service answers a model list
// request, for CheckModelLister.
type ModelListService struct {
	// Path is the request path of the model list.
	Path string
	// Page renders a successful answer, on one page, listing ids.
	Page func(ids []string) string
	// ErrorHeader is sent with every error response, for example to have a
	// client that retries do so without waiting.
	ErrorHeader http.Header
	// Key is the API key New configures; no error may contain it.
	Key string
	// New builds the provider's lister for a service at baseURL (the test
	// server's URL, without a path), configured with Key.
	New func(t *testing.T, baseURL string) ai.ModelLister
	// Unreachable and Cancelled are what the errors for a service that
	// cannot be reached and for a cancelled request say; "" checks only that
	// the error is safe.
	Unreachable, Cancelled string
}

// CheckModelLister checks what every ai.ModelLister reports the same way: a
// rejected key, a service without a model list, another error status, a list
// over the size or the entry bound, a cancelled request and an unreachable
// service. Errors are *ai.Error, carry the upstream status (0 without one)
// and never contain the key.
func CheckModelLister(t *testing.T, s ModelListService) {
	t.Helper()
	var mu sync.Mutex
	status, body := http.StatusOK, ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != s.Path {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		st, b := status, body
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if st != http.StatusOK {
			for k, v := range s.ErrorHeader {
				w.Header()[k] = v
			}
		}
		w.WriteHeader(st)
		io.WriteString(w, b)
	}))
	defer srv.Close()
	serve := func(st int, b string) {
		mu.Lock()
		status, body = st, b
		mu.Unlock()
	}
	l := s.New(t, srv.URL)
	// failed checks that err is a safe *ai.Error with the status, whose
	// message contains want.
	failed := func(t *testing.T, err error, want string, wantStatus int) {
		t.Helper()
		var pe *ai.Error
		switch {
		case !errors.As(err, &pe):
			t.Fatalf("got %T %v, want an *ai.Error", err, err)
		case strings.Contains(err.Error(), s.Key):
			t.Errorf("the key leaked: %v", err)
		case !strings.Contains(err.Error(), want):
			t.Errorf("got %q, want it to contain %q", err, want)
		case pe.Status != wantStatus:
			t.Errorf("%q: status %d, want %d", err, pe.Status, wantStatus)
		}
	}

	t.Run("listed", func(t *testing.T) {
		serve(http.StatusOK, s.Page([]string{"model-b", "model-a"}))
		ids, err := l.ListModels(context.Background())
		if err != nil || strings.Join(ids, ",") != "model-b,model-a" {
			t.Errorf("ids %v, err %v", ids, err)
		}
	})
	for _, c := range []struct {
		status int
		want   string
	}{
		{http.StatusUnauthorized, "rejected the API key"},
		{http.StatusNotFound, "does not list"},
		{http.StatusInternalServerError, "HTTP 500"},
	} {
		t.Run(fmt.Sprint(c.status), func(t *testing.T) {
			serve(c.status, `{"type":"error","error":{"type":"api_error","code":`+fmt.Sprint(c.status)+
				`,"message":"bad key `+s.Key+`"}}`)
			_, err := l.ListModels(context.Background())
			failed(t, err, c.want, c.status)
		})
	}
	t.Run("too large", func(t *testing.T) {
		serve(http.StatusOK, s.Page([]string{strings.Repeat("x", ai.MaxModelListBytes)}))
		_, err := l.ListModels(context.Background())
		failed(t, err, "too large", 0)
	})
	t.Run("entry bound", func(t *testing.T) {
		ids := make([]string, ai.MaxModelListEntries+10)
		for i := range ids {
			ids[i] = fmt.Sprintf("m%d", i)
		}
		serve(http.StatusOK, s.Page(ids))
		got, err := l.ListModels(context.Background())
		if err != nil || len(got) != ai.MaxModelListEntries || got[0] != "m0" || got[len(got)-1] != ids[ai.MaxModelListEntries-1] {
			t.Errorf("%d ids, err %v", len(got), err)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		serve(http.StatusOK, s.Page([]string{"model-a"}))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := l.ListModels(ctx)
		failed(t, err, s.Cancelled, 0)
	})
	t.Run("unreachable", func(t *testing.T) {
		srv.Close()
		_, err := l.ListModels(context.Background())
		failed(t, err, s.Unreachable, 0)
	})
}

package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

// Prefix is where the API is mounted.
const Prefix = "/api/v1"

// Options configure the HTTP server.
type Options struct {
	App    *app.App
	Logger *slog.Logger
	// AllowedOrigins are extra origins allowed to send state-changing
	// requests, in addition to the server's own and loopback origins.
	AllowedOrigins []string
	// AllowedHosts are the Host header values (host names or addresses,
	// without port) accepted on /api/ and /mcp in addition to loopback
	// names and addresses. "*" accepts any host.
	AllowedHosts []string
	// MCP is mounted at MCPPath when non-nil.
	MCP     http.Handler
	MCPPath string
	// Web serves the UI for every other path.
	Web http.Handler
}

// Server routes requests to the API, the MCP endpoint and the UI.
type Server struct {
	app     *app.App
	log     *slog.Logger
	origins []string
	hosts   []string
	api     *http.ServeMux
	mcp     http.Handler
	mcpPath string
	web     http.Handler
}

// New returns the root HTTP handler.
func New(opts Options) *Server {
	s := &Server{app: opts.App, log: opts.Logger, origins: opts.AllowedOrigins, hosts: opts.AllowedHosts, mcp: opts.MCP,
		mcpPath: opts.MCPPath, web: opts.Web, api: http.NewServeMux()}
	if s.log == nil {
		s.log = slog.New(slog.DiscardHandler)
	}
	if s.mcpPath == "" {
		s.mcpPath = "/mcp"
	}
	s.routes()
	return s
}

func (s *Server) handle(pattern string, h func(w http.ResponseWriter, r *http.Request) error) {
	method, path, _ := strings.Cut(pattern, " ")
	s.api.HandleFunc(method+" "+Prefix+path, func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			s.writeError(w, r, err)
		}
	})
}

func (s *Server) routes() {
	s.handle("GET /meta", s.getMeta)
	s.handle("GET /stats", s.getStats)

	s.handle("GET /items", s.listItems)
	s.handle("POST /items", s.createItem)
	s.handle("POST /items/bulk", s.bulkItems)
	s.handle("GET /items/{id}", s.getItem)
	s.handle("PATCH /items/{id}", s.updateItem)
	s.handle("DELETE /items/{id}", s.deleteItem)
	s.handle("POST /items/{id}/edits", s.editItem)

	s.handle("GET /items/{id}/testcases", s.listTestCases)
	s.handle("POST /items/{id}/testcases", s.addTestCase)
	s.handle("POST /items/{id}/testcases/bulk", s.bulkTestCases)
	s.handle("PUT /items/{id}/testcases/order", s.orderTestCases)
	s.handle("POST /items/{id}/testcases/verify", s.verifyTestCases)
	s.handle("PATCH /testcases/{id}", s.updateTestCase)

	s.handle("GET /items/{id}/solutions", s.listSolutions)
	s.handle("POST /items/{id}/solutions", s.createSolution)
	s.handle("PATCH /solutions/{id}", s.updateSolution)
	s.handle("DELETE /solutions/{id}", s.deleteSolution)
	s.handle("DELETE /testcases/{id}", s.deleteTestCase)

	s.handle("GET /collections", s.listCollections)
	s.handle("POST /collections", s.createCollection)
	s.handle("GET /collections/{id}", s.getCollection)
	s.handle("PATCH /collections/{id}", s.updateCollection)
	s.handle("DELETE /collections/{id}", s.deleteCollection)
	s.handle("GET /collections/{id}/items", s.getCollectionItems)
	s.handle("PUT /collections/{id}/items", s.setCollectionItems)
	s.handle("POST /collections/{id}/items", s.addCollectionItems)
	s.handle("DELETE /collections/{id}/items/{itemId}", s.removeCollectionItem)

	s.handle("GET /tags", s.listTags)
	s.handle("PATCH /tags/{name}", s.renameTag)
	s.handle("DELETE /tags/{name}", s.deleteTag)

	s.handle("POST /items/{id}/submissions", s.createSubmission)
	s.handle("GET /items/{id}/submissions", s.listSubmissions)
	s.handle("GET /submissions/{id}", s.getSubmission)

	s.handle("POST /ai/draft", s.aiDraft)
	s.handle("POST /items/{id}/ai/variant", s.aiVariant)
	s.handle("POST /items/{id}/ai/testcases", s.aiTestCases)

	s.handle("GET /settings/ai", s.getAISettings)
	s.handle("PUT /settings/ai", s.putAISettings)
	s.handle("POST /settings/ai/test", s.testAISettings)
	s.handle("POST /settings/ai/providers", s.createAIProvider)
	s.handle("PATCH /settings/ai/providers/{id}", s.updateAIProvider)
	s.handle("DELETE /settings/ai/providers/{id}", s.deleteAIProvider)
	s.handle("GET /settings/ai/log", s.listAILog)
	s.handle("GET /settings/ai/log/{id}", s.getAILogEntry)
	s.handle("DELETE /settings/ai/log", s.deleteAILog)
	s.handle("GET /settings/preferences", s.getPreferences)
	s.handle("PUT /settings/preferences", s.putPreferences)

	s.handle("GET /styles", s.listStyles)
	s.handle("POST /styles", s.createStyle)
	s.handle("PATCH /styles/{id}", s.updateStyle)
	s.handle("DELETE /styles/{id}", s.deleteStyle)

	s.handle("POST /export", s.export)
	s.handle("POST /import/preview", s.importPreview)
	s.handle("POST /import", s.importBundle)

	// Unknown API paths and wrong methods get JSON errors.
	s.api.HandleFunc("/", s.apiFallback)
}

var methods = []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}

func (s *Server) apiFallback(w http.ResponseWriter, r *http.Request) {
	var allowed []string
	for _, m := range methods {
		probe := r.Clone(r.Context())
		probe.Method = m
		if _, pattern := s.api.Handler(probe); pattern != "/" && pattern != "" {
			allowed = append(allowed, m)
		}
	}
	if len(allowed) > 0 {
		w.Header().Set("Allow", strings.Join(allowed, ", "))
		writeJSON(w, http.StatusMethodNotAllowed, errorBody{Error: errorDetail{Code: app.CodeBadRequest,
			Message: "method " + r.Method + " is not allowed for this path"}})
		return
	}
	writeJSON(w, http.StatusNotFound, errorBody{Error: errorDetail{Code: app.CodeNotFound, Message: "no such endpoint"}})
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	rec := &statusRecorder{ResponseWriter: w}
	defer func() {
		if p := recover(); p != nil {
			s.log.Error("panic serving request", "path", r.URL.Path, "panic", p, "stack", string(debug.Stack()))
			if rec.status == 0 {
				writeJSON(rec, http.StatusInternalServerError, errorBody{Error: errorDetail{Code: app.CodeInternal, Message: "internal server error"}})
			}
		}
		level := slog.LevelDebug
		if rec.status >= 500 {
			level = slog.LevelWarn
		}
		s.log.Log(r.Context(), level, "request", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"duration", time.Since(start).Round(time.Millisecond))
	}()
	h := rec.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")

	path := r.URL.Path
	isAPI := path == "/api" || strings.HasPrefix(path, "/api/")
	isMCP := path == s.mcpPath || strings.HasPrefix(path, s.mcpPath+"/")
	if (isAPI || isMCP) && !HostAllowed(r.Host, s.hosts) {
		writeJSON(rec, http.StatusForbidden, errorBody{Error: errorDetail{Code: app.CodeForbidden, Message: hostMessage(r.Host)}})
		return
	}
	switch {
	case isAPI:
		h.Set("Cache-Control", "no-store")
		setDeadlines(rec, path)
		if !safeMethod(r.Method) && !s.originAllowed(r, s.origins) {
			writeJSON(rec, http.StatusForbidden, errorBody{Error: errorDetail{Code: app.CodeForbidden,
				Message: "cross-origin requests are not allowed; set CODEATROPHY_ALLOWED_ORIGINS to allow this origin"}})
			return
		}
		s.api.ServeHTTP(rec, r)
	case isMCP:
		// MCP streams are long-lived: no deadline (and clear any left on a
		// kept-alive connection by an earlier request).
		rc := http.NewResponseController(rec)
		_ = rc.SetWriteDeadline(time.Time{})
		_ = rc.SetReadDeadline(time.Time{})
		if s.mcp == nil {
			writeJSON(rec, http.StatusNotFound, errorBody{Error: errorDetail{Code: app.CodeNotFound, Message: "the MCP endpoint is disabled"}})
			return
		}
		s.mcp.ServeHTTP(rec, r)
	default:
		h.Set("X-Frame-Options", "DENY")
		setDeadlines(rec, path)
		if s.web == nil {
			http.NotFound(rec, r)
			return
		}
		s.web.ServeHTTP(rec, r)
	}
}

// Request deadlines. The server itself has no write timeout, because the
// MCP endpoint holds long-lived streams; other routes get one here. AI
// requests, verification runs and bundle transfers may legitimately take
// minutes.
const (
	defaultDeadline = 2 * time.Minute
	longDeadline    = 6 * time.Minute
)

func longRunning(path string) bool {
	p := strings.TrimPrefix(path, Prefix)
	return strings.HasPrefix(p, "/ai/") || strings.Contains(p, "/ai/") ||
		strings.HasSuffix(p, "/testcases/verify") || p == "/export" || strings.HasPrefix(p, "/import")
}

func setDeadlines(w http.ResponseWriter, path string) {
	d := defaultDeadline
	if longRunning(path) {
		d = longDeadline
	}
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(d))
	_ = rc.SetReadDeadline(time.Now().Add(d))
}

// HostAllowed reports whether a request's Host header is acceptable: a
// loopback name or address (any port), or one of allowed. This blocks DNS
// rebinding, where a hostile page re-points its own host name at this
// server and then reads from it as same-origin.
func HostAllowed(hostport string, allowed []string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
	if host == "" {
		return false
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	for _, a := range allowed {
		if a == "*" || strings.EqualFold(strings.TrimSuffix(a, "."), host) {
			return true
		}
	}
	return false
}

func hostMessage(host string) string {
	return fmt.Sprintf("requests for host %q are not accepted; set CODEATROPHY_PUBLIC_URL to the URL you reach this "+
		"server at, or add the host to CODEATROPHY_ALLOWED_HOSTS", host)
}

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// OriginAllowed reports whether a request's Origin header (if any) is
// acceptable: a loopback origin, one of allowedOrigins, or an origin whose
// host is in allowedHosts. It never compares against the request's own Host
// header, which an attacker controls under DNS rebinding.
func OriginAllowed(r *http.Request, allowedOrigins, allowedHosts []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if origin == "null" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := u.Hostname()
	for _, h := range allowedHosts {
		if h != "*" && strings.EqualFold(strings.TrimSuffix(h, "."), host) {
			return true
		}
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	o := strings.TrimRight(origin, "/")
	for _, a := range allowedOrigins {
		if strings.EqualFold(a, o) {
			return true
		}
	}
	return false
}

func (s *Server) originAllowed(r *http.Request, allowed []string) bool {
	return OriginAllowed(r, allowed, s.hosts)
}

// Handlers.

func (s *Server) getMeta(w http.ResponseWriter, r *http.Request) error {
	m, err := s.app.Meta(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, m)
	return nil
}

func (s *Server) getStats(w http.ResponseWriter, r *http.Request) error {
	st, err := s.app.Stats(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, st)
	return nil
}

func (s *Server) listItems(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	in := app.ItemQuery{
		Q: q.Get("q"), ID: queryList(r, "id"), Type: q.Get("type"), Status: queryList(r, "status"), Difficulty: queryList(r, "difficulty"),
		Tag: r.URL.Query()["tag"], CollectionID: q.Get("collectionId"), VariantOf: q.Get("variantOf"),
		Sort: q.Get("sort"), Order: q.Get("order"),
	}
	var err error
	if in.Limit, err = queryInt(r, "limit"); err != nil {
		return err
	}
	if off, err := queryInt(r, "offset"); err != nil {
		return err
	} else if off != nil {
		in.Offset = *off
	}
	if b, err := queryBool(r, "recursive"); err != nil {
		return err
	} else if b != nil {
		in.Recursive = *b
	}
	if b, err := queryBool(r, "uncollected"); err != nil {
		return err
	} else if b != nil {
		in.Uncollected = *b
	}
	if in.Favorite, err = queryBool(r, "favorite"); err != nil {
		return err
	}
	page, err := s.app.ListItems(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, page)
	return nil
}

func (s *Server) createItem(w http.ResponseWriter, r *http.Request) error {
	var in domain.ItemInput
	if err := decode(r, &in); err != nil {
		return err
	}
	it, err := s.app.CreateItem(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, it)
	return nil
}

func (s *Server) getItem(w http.ResponseWriter, r *http.Request) error {
	it, err := s.app.GetItem(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, it)
	return nil
}

func (s *Server) updateItem(w http.ResponseWriter, r *http.Request) error {
	var in domain.ItemInput
	if err := decode(r, &in); err != nil {
		return err
	}
	it, err := s.app.UpdateItem(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, it)
	return nil
}

func (s *Server) deleteItem(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteItem(r.Context(), r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) editItem(w http.ResponseWriter, r *http.Request) error {
	var in app.EditTextInput
	if err := decode(r, &in); err != nil {
		return err
	}
	it, err := s.app.EditItemText(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, it)
	return nil
}

func (s *Server) bulkItems(w http.ResponseWriter, r *http.Request) error {
	var in app.BulkInput
	if err := decode(r, &in); err != nil {
		return err
	}
	res, err := s.app.BulkItems(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) listTestCases(w http.ResponseWriter, r *http.Request) error {
	l, err := s.app.ListTestCases(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, l)
	return nil
}

func (s *Server) addTestCase(w http.ResponseWriter, r *http.Request) error {
	var in domain.TestCaseInput
	if err := decode(r, &in); err != nil {
		return err
	}
	tc, err := s.app.AddTestCase(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, tc)
	return nil
}

func (s *Server) bulkTestCases(w http.ResponseWriter, r *http.Request) error {
	var in app.BulkTestCasesInput
	if err := decode(r, &in); err != nil {
		return err
	}
	l, err := s.app.BulkTestCases(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, l)
	return nil
}

func (s *Server) orderTestCases(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		IDs []string `json:"ids"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	l, err := s.app.ReorderTestCases(r.Context(), r.PathValue("id"), in.IDs)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, l)
	return nil
}

func (s *Server) verifyTestCases(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		UpdateExpected bool    `json:"updateExpected"`
		SolutionID     *string `json:"solutionId"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	solutionID := ""
	if in.SolutionID != nil {
		solutionID = *in.SolutionID
	}
	res, err := s.app.VerifyTestCases(r.Context(), r.PathValue("id"), in.UpdateExpected, solutionID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) updateTestCase(w http.ResponseWriter, r *http.Request) error {
	var in domain.TestCaseInput
	if err := decode(r, &in); err != nil {
		return err
	}
	tc, err := s.app.UpdateTestCase(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, tc)
	return nil
}

func (s *Server) deleteTestCase(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteTestCase(r.Context(), r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listCollections(w http.ResponseWriter, r *http.Request) error {
	l, err := s.app.ListCollections(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, l)
	return nil
}

func (s *Server) createCollection(w http.ResponseWriter, r *http.Request) error {
	var in domain.CollectionInput
	if err := decode(r, &in); err != nil {
		return err
	}
	c, err := s.app.CreateCollection(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, c)
	return nil
}

func (s *Server) getCollection(w http.ResponseWriter, r *http.Request) error {
	c, err := s.app.GetCollection(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, c)
	return nil
}

func (s *Server) updateCollection(w http.ResponseWriter, r *http.Request) error {
	var in domain.CollectionInput
	if err := decode(r, &in); err != nil {
		return err
	}
	c, err := s.app.UpdateCollection(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, c)
	return nil
}

func (s *Server) deleteCollection(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteCollection(r.Context(), r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type itemIDsBody struct {
	ItemIDs []string `json:"itemIds"`
}

func (s *Server) getCollectionItems(w http.ResponseWriter, r *http.Request) error {
	res, err := s.app.CollectionItemIDs(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) setCollectionItems(w http.ResponseWriter, r *http.Request) error {
	var in itemIDsBody
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.ItemIDs == nil {
		in.ItemIDs = []string{}
	}
	res, err := s.app.SetCollectionItems(r.Context(), r.PathValue("id"), in.ItemIDs)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) addCollectionItems(w http.ResponseWriter, r *http.Request) error {
	var in itemIDsBody
	if err := decode(r, &in); err != nil {
		return err
	}
	res, err := s.app.AddCollectionItems(r.Context(), r.PathValue("id"), in.ItemIDs)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) removeCollectionItem(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.RemoveCollectionItem(r.Context(), r.PathValue("id"), r.PathValue("itemId")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listTags(w http.ResponseWriter, r *http.Request) error {
	l, err := s.app.ListTags(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, l)
	return nil
}

func (s *Server) renameTag(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Name string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	t, err := s.app.RenameTag(r.Context(), r.PathValue("name"), in.Name)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, t)
	return nil
}

func (s *Server) deleteTag(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteTag(r.Context(), r.PathValue("name")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) createSubmission(w http.ResponseWriter, r *http.Request) error {
	var in app.SubmissionInput
	if err := decode(r, &in); err != nil {
		return err
	}
	sub, err := s.app.CreateSubmission(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, sub)
	return nil
}

func (s *Server) listSubmissions(w http.ResponseWriter, r *http.Request) error {
	q := app.SubmissionQuery{Mode: r.URL.Query().Get("mode")}
	var err error
	if q.Limit, err = queryInt(r, "limit"); err != nil {
		return err
	}
	if off, err := queryInt(r, "offset"); err != nil {
		return err
	} else if off != nil {
		q.Offset = *off
	}
	page, err := s.app.ListSubmissions(r.Context(), r.PathValue("id"), q)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, page)
	return nil
}

func (s *Server) getSubmission(w http.ResponseWriter, r *http.Request) error {
	sub, err := s.app.GetSubmission(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, sub)
	return nil
}

func (s *Server) aiDraft(w http.ResponseWriter, r *http.Request) error {
	var in app.DraftInput
	if err := decode(r, &in); err != nil {
		return err
	}
	res, err := s.app.Draft(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) aiVariant(w http.ResponseWriter, r *http.Request) error {
	var in app.VariantInput
	if err := decode(r, &in); err != nil {
		return err
	}
	res, err := s.app.Variant(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) aiTestCases(w http.ResponseWriter, r *http.Request) error {
	var in app.GenerateTestCasesInput
	if err := decode(r, &in); err != nil {
		return err
	}
	res, err := s.app.GenerateTestCases(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) getAISettings(w http.ResponseWriter, r *http.Request) error {
	st, err := s.app.GetAISettings(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, st)
	return nil
}

func (s *Server) putAISettings(w http.ResponseWriter, r *http.Request) error {
	var in app.AISettingsInput
	if err := decode(r, &in); err != nil {
		return err
	}
	st, err := s.app.UpdateAISettings(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, st)
	return nil
}

func (s *Server) testAISettings(w http.ResponseWriter, r *http.Request) error {
	var in app.AITestInput
	if err := decode(r, &in); err != nil {
		return err
	}
	res, err := s.app.TestAIProvider(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) createAIProvider(w http.ResponseWriter, r *http.Request) error {
	var in app.AIProviderInput
	if err := decode(r, &in); err != nil {
		return err
	}
	p, err := s.app.CreateAIProvider(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, p)
	return nil
}

func (s *Server) updateAIProvider(w http.ResponseWriter, r *http.Request) error {
	var in app.AIProviderInput
	if err := decode(r, &in); err != nil {
		return err
	}
	p, err := s.app.UpdateAIProvider(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, p)
	return nil
}

func (s *Server) deleteAIProvider(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteAIProvider(r.Context(), r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listAILog(w http.ResponseWriter, r *http.Request) error {
	v := r.URL.Query()
	q := app.AILogQuery{ProviderID: v.Get("providerId"), Operation: v.Get("operation"), Status: v.Get("status"),
		Before: v.Get("before")}
	var err error
	if q.Limit, err = queryInt(r, "limit"); err != nil {
		return err
	}
	page, err := s.app.ListAILog(r.Context(), q)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, page)
	return nil
}

func (s *Server) getAILogEntry(w http.ResponseWriter, r *http.Request) error {
	e, err := s.app.GetAILogEntry(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, e)
	return nil
}

func (s *Server) deleteAILog(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteAILog(r.Context(), r.URL.Query().Get("before")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listStyles(w http.ResponseWriter, r *http.Request) error {
	l, err := s.app.ListStylePresets(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, l)
	return nil
}

func (s *Server) createStyle(w http.ResponseWriter, r *http.Request) error {
	var in domain.StylePresetInput
	if err := decode(r, &in); err != nil {
		return err
	}
	p, err := s.app.CreateStylePreset(r.Context(), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, p)
	return nil
}

func (s *Server) updateStyle(w http.ResponseWriter, r *http.Request) error {
	var in domain.StylePresetInput
	if err := decode(r, &in); err != nil {
		return err
	}
	p, err := s.app.UpdateStylePreset(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, p)
	return nil
}

func (s *Server) deleteStyle(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteStylePreset(r.Context(), r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) export(w http.ResponseWriter, r *http.Request) error {
	var in app.ExportInput
	if err := decode(r, &in); err != nil {
		return err
	}
	res, err := s.app.Export(r.Context(), in)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": res.Filename}))
	w.Header().Set("Content-Length", strconv.Itoa(len(res.Data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(res.Data)
	return nil
}

// readUpload reads the "file" part (and the "strategy" field) of a
// multipart upload without spooling it to disk.
func (s *Server) readUpload(r *http.Request) ([]byte, string, error) {
	max := s.app.Limits().MaxImportBytes
	r.Body = http.MaxBytesReader(nil, r.Body, max+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, "", apiError(app.CodeBadRequest, "expected a multipart/form-data upload with a file part")
	}
	var data []byte
	var strategy string
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, "", uploadError(err, max)
		}
		switch part.FormName() {
		case "file":
			data, err = io.ReadAll(io.LimitReader(part, max+1))
			if err != nil {
				return nil, "", uploadError(err, max)
			}
			if int64(len(data)) > max {
				return nil, "", apiError(app.CodeTooLarge, "the bundle exceeds the maximum size of %d bytes", max)
			}
		case "strategy":
			b, err := io.ReadAll(io.LimitReader(part, 64))
			if err != nil {
				return nil, "", uploadError(err, max)
			}
			strategy = strings.TrimSpace(string(b))
		}
		part.Close()
	}
	if data == nil {
		return nil, "", apiError(app.CodeBadRequest, "the upload has no file part")
	}
	return data, strategy, nil
}

func uploadError(err error, max int64) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return apiError(app.CodeTooLarge, "the upload exceeds the maximum size of %d bytes", max)
	}
	if errors.Is(err, multipart.ErrMessageTooLarge) {
		return apiError(app.CodeTooLarge, "the upload is too large")
	}
	return apiError(app.CodeBadRequest, "the upload could not be read")
}

func (s *Server) importPreview(w http.ResponseWriter, r *http.Request) error {
	data, _, err := s.readUpload(r)
	if err != nil {
		return err
	}
	p, err := s.app.PreviewImport(r.Context(), data)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, p)
	return nil
}

func (s *Server) importBundle(w http.ResponseWriter, r *http.Request) error {
	data, strategy, err := s.readUpload(r)
	if err != nil {
		return err
	}
	res, err := s.app.Import(r.Context(), data, strategy)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

func (s *Server) listSolutions(w http.ResponseWriter, r *http.Request) error {
	l, err := s.app.ListSolutions(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, l)
	return nil
}

func (s *Server) createSolution(w http.ResponseWriter, r *http.Request) error {
	var in domain.ItemSolutionInput
	if err := decode(r, &in); err != nil {
		return err
	}
	sol, err := s.app.CreateSolution(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, sol)
	return nil
}

func (s *Server) updateSolution(w http.ResponseWriter, r *http.Request) error {
	var in domain.ItemSolutionInput
	if err := decode(r, &in); err != nil {
		return err
	}
	sol, err := s.app.UpdateSolution(r.Context(), r.PathValue("id"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, sol)
	return nil
}

func (s *Server) deleteSolution(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteSolution(r.Context(), r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) getPreferences(w http.ResponseWriter, r *http.Request) error {
	p, err := s.app.GetPreferences(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, p)
	return nil
}

func (s *Server) putPreferences(w http.ResponseWriter, r *http.Request) error {
	var raw json.RawMessage
	if err := decode(r, &raw); err != nil {
		return err
	}
	p, err := s.app.UpdatePreferences(r.Context(), raw)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, p)
	return nil
}

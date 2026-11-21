package judge0

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// Judge0 keeps every submission it runs (source, input, expected and actual
// output) in its own database and never removes one. The adapter reads each
// result once, and Codeatrophy keeps its own record, so once a result has
// been read the adapter deletes the submission in Judge0: DELETE
// /submissions/{token}. That needs ENABLE_SUBMISSION_DELETE=true on the
// server and the authorization token (AUTHZ_TOKEN) in the X-Auth-User
// header; without a token the adapter deletes nothing, since Judge0 refuses
// every delete when AUTHZ_TOKEN is unset. Judge0 also refuses to delete a
// submission still queued or running.
//
// Deletes are best effort and never on the result path: tokens go into a
// queue that one background goroutine works through. A run the adapter
// stopped waiting for (cancelled, timed out, or the poll failed) is queued
// too, and retried with backoff until Judge0 has finished it. A failure is
// logged, and the submission stays in Judge0.

const (
	// cleanupQueue bounds the tokens waiting to be deleted; beyond it a
	// token is dropped (and its submission kept by Judge0).
	cleanupQueue = 4096
	// cleanupTimeout bounds one delete request.
	cleanupTimeout = 15 * time.Second
	// cleanupTries bounds the attempts for one token. With the backoff
	// below they span about 9 minutes, longer than the default execution
	// timeout of 5 minutes, so an abandoned run is usually finished and
	// deleted within them.
	cleanupTries = 14
	// cleanupMaxBackoff caps the wait between two attempts.
	cleanupMaxBackoff = time.Minute
)

type cleanupJob struct {
	token string
	tries int
}

// cleaner deletes submissions in the background.
type cleaner struct {
	queue chan cleanupJob
	// backoff is the wait before attempt n+1 (n counted from 1).
	backoff func(n int) time.Duration
	// warned is set once a refusal other than "not finished" was logged at
	// warning level; later ones are logged at debug level.
	warned atomic.Bool
	// offWarned is set once the server was found to refuse deletes.
	offWarned atomic.Bool
	// pending counts tokens queued or waiting for a retry, for tests.
	pending atomic.Int64
}

func defaultBackoff(n int) time.Duration {
	return min(time.Second<<min(n-1, 6), cleanupMaxBackoff)
}

// deletes reports whether the adapter deletes finished submissions: it has
// an authorization token, and the server allows deletes (or did not say).
func (e *Engine) deletes() bool {
	if e.cfg.AuthzToken == "" {
		return false
	}
	e.mu.Lock()
	c := e.cat
	e.mu.Unlock()
	return c == nil || c.deleteAllowed
}

// forget queues finished or abandoned submissions for deletion. It never
// blocks.
func (e *Engine) forget(tokens ...string) {
	if !e.deletes() {
		return
	}
	e.cleanOnce.Do(func() { go e.cleanLoop() })
	for _, tok := range tokens {
		if tok != "" {
			e.requeue(cleanupJob{token: tok})
		}
	}
}

func (e *Engine) requeue(j cleanupJob) {
	e.clean.pending.Add(1)
	select {
	case e.clean.queue <- j:
	default:
		e.clean.pending.Add(-1)
		e.log.Debug("judge0: cleanup queue full; the submission stays in Judge0", "token", j.token)
	}
}

func (e *Engine) cleanLoop() {
	for j := range e.clean.queue {
		e.cleanOne(j)
	}
}

func (e *Engine) cleanOne(j cleanupJob) {
	j.tries++
	retry, err := e.deleteSubmission(j.token)
	switch {
	case err == nil:
		e.clean.pending.Add(-1)
	case retry && j.tries < cleanupTries:
		time.AfterFunc(e.clean.backoff(j.tries), func() {
			select {
			case e.clean.queue <- j:
			default:
				e.clean.pending.Add(-1)
				e.log.Debug("judge0: cleanup queue full; the submission stays in Judge0", "token", j.token)
			}
		})
	default:
		e.clean.pending.Add(-1)
		level := e.log.Debug
		if !e.clean.warned.Swap(true) {
			level = e.log.Warn
		}
		level("judge0: could not delete a finished submission; it stays in Judge0's database "+
			"(further failures are logged at debug level)", "token", j.token, "attempts", j.tries, "error", err)
	}
}

// deleteSubmission deletes one submission. retry reports a failure worth
// trying again: the submission is not finished yet, or Judge0 could not be
// reached or failed. A submission already gone counts as deleted.
func (e *Engine) deleteSubmission(token string) (retry bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	req, err := e.newRequest(ctx, http.MethodDelete, "/submissions/"+token+"?fields=token", nil)
	if err != nil {
		return false, err
	}
	req.Header.Set(authzHeader, e.cfg.AuthzToken)
	resp, err := e.client.Do(req)
	if err != nil {
		return true, unwrapURLError(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300, resp.StatusCode == http.StatusNotFound:
		return false, nil
	case resp.StatusCode == http.StatusBadRequest && strings.Contains(string(body), "cannot be deleted because its status"):
		return true, httpStatusError(resp.StatusCode, body)
	case resp.StatusCode >= 500:
		return true, httpStatusError(resp.StatusCode, body)
	default:
		// 400 "delete not allowed" (ENABLE_SUBMISSION_DELETE is off), 401
		// (authentication) or 403 (AUTHZ_TOKEN unset or another token).
		return false, httpStatusError(resp.StatusCode, body)
	}
}

// authzHeader carries the authorization token; it is Judge0's default
// AUTHZ_HEADER.
const authzHeader = "X-Auth-User"

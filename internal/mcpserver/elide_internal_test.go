package mcpserver

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestElide(t *testing.T) {
	big := strings.Repeat("ab", elideBytes/2) + "c" // one byte over
	exact := strings.Repeat("x", elideBytes)
	doc, _ := json.Marshal(map[string]any{
		"z": 1.5e300, "stdin": big, "results": []any{map[string]any{"stdout": big, "stderr": big, "n": json.Number("12345678901234567890")}},
		"expectedStdout": exact, "name": big, "actualStdout": nil, "flag": true,
	})
	out, err := elide(doc, elideBytes)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("not JSON: %v\n%.300s", err, out)
	}
	if got["stdin"] != nil || got["stdinBytes"] != float64(len(big)) || got["stdinHead"] != big[:headBytes] {
		t.Errorf("stdin: %v %v %v", got["stdin"], got["stdinBytes"], got["stdinHead"])
	}
	r := got["results"].([]any)[0].(map[string]any)
	if r["stdout"] != nil || r["stdoutBytes"] != float64(len(big)) || r["stderr"] != big {
		t.Errorf("nested: stdout %v, stderr kept %v", r["stdout"], r["stderr"] == big)
	}
	if got["expectedStdout"] != exact || got["name"] != big || got["actualStdout"] != nil || got["flag"] != true {
		t.Error("a value that is not large test data was changed")
	}
	if _, ok := got["expectedStdoutBytes"]; ok {
		t.Error("a value at the bound was elided")
	}
	// Numbers are kept as written, and so is the order of the fields.
	if !strings.Contains(string(out), `"n":12345678901234567890`) || !strings.Contains(string(out), `"z":1.5e+300`) {
		t.Errorf("numbers: %.200s", out)
	}
	ordered, _ := elide([]byte(`{"b":1,"stdin":"`+big+`","a":[true,null,"x"]}`), elideBytes)
	if !strings.HasPrefix(string(ordered), `{"b":1,"stdin":null,"stdinBytes":`) || !strings.HasSuffix(string(ordered), `,"a":[true,null,"x"]}`) {
		t.Errorf("order: %.80s ... %s", ordered, ordered[len(ordered)-40:])
	}
	// A small document is returned as it is.
	small := []byte(`{"stdin": "1 2"}`)
	if out, _ := elide(small, elideBytes); string(out) != string(small) {
		t.Errorf("small: %s", out)
	}
}

func TestHeadKeepsWholeCharacters(t *testing.T) {
	s := strings.Repeat("a", headBytes-1) + "é" + "tail"
	h := head(s, headBytes)
	if h != strings.Repeat("a", headBytes-1) || !utf8.ValidString(h) {
		t.Errorf("head: %q", h[len(h)-5:])
	}
	if head("short", headBytes) != "short" {
		t.Error("a short string is its own head")
	}
}

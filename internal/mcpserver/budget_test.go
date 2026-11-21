package mcpserver_test

import (
	"encoding/json"
	"testing"
)

// What a harness pays for this server before the first call: the
// instructions and the tool definitions. They are kept within a budget so
// that they do not grow back unnoticed.
const (
	maxInstructionsChars = 2000
	maxToolDescChars     = 700
	// toolsBudget bounds the compact JSON of every tool's name, description
	// and input schema: 28,203 bytes when it was set, plus about 3%. Raise
	// it only for a definition that pays for itself.
	toolsBudget = 29050
)

func TestContextBudget(t *testing.T) {
	f := newFixture(t, "")
	s1, s2 := f.connect(t, ""), f.connect(t, "")
	in1, in2 := s1.InitializeResult().Instructions, s2.InitializeResult().Instructions
	if n := len([]rune(in1)); n > maxInstructionsChars {
		t.Errorf("instructions are %d characters, budget %d", n, maxInstructionsChars)
	}
	if in1 != in2 {
		t.Error("instructions differ between sessions")
	}
	res, err := s1.ListTools(f.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	type def struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		InputSchema any    `json:"inputSchema"`
	}
	defs := make([]def, len(res.Tools))
	for i, tool := range res.Tools {
		if n := len([]rune(tool.Description)); n > maxToolDescChars {
			t.Errorf("%s: description is %d characters, budget %d", tool.Name, n, maxToolDescChars)
		}
		defs[i] = def{tool.Name, tool.Description, tool.InputSchema}
	}
	b, err := json.Marshal(defs)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > toolsBudget {
		t.Errorf("the tool definitions are %d bytes of compact JSON, budget %d", len(b), toolsBudget)
	}
}

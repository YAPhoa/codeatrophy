package mcpserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"codeatrophy/internal/domain"
)

// Test data in tool results. A large test case's input runs to a megabyte,
// and its expected output may too: returned whole, one such case would
// fill an assistant's context. Tool results therefore show test data
// larger than a limit by its size and its first bytes only. The limit is
// elideBytes by default, fullElideBytes when the caller asks for full data,
// and echoElideBytes in the results of the tools that write test cases,
// which return data the caller has just sent. This is presentation for MCP
// alone; the HTTP API returns the data in full.
const (
	elideBytes     = 2 << 10
	fullElideBytes = 16 << 10
	echoElideBytes = 512
	headBytes      = 200
)

// elideLimit is the limit of a tool that offers full: true.
func elideLimit(full bool) int {
	if full {
		return fullElideBytes
	}
	return elideBytes
}

// elidedFields are the fields that hold test data: a case's input and
// expected output, and what a program printed on it (actualStdout in a
// verification, stdout in a submission's results).
var elidedFields = map[string]bool{"stdin": true, "expectedStdout": true, "actualStdout": true, "stdout": true}

// elide rewrites a JSON document so that each string field named in
// elidedFields that is larger than limit bytes becomes null, followed by
// <field>Bytes (its size) and <field>Head (its first headBytes bytes, cut
// back to a UTF-8 boundary). Everything else, the order of fields
// included, is kept. A document too small to hold such a string is
// returned as it is.
func elide(doc []byte, limit int) ([]byte, error) {
	if len(doc) <= limit {
		return doc, nil
	}
	dec := json.NewDecoder(bytes.NewReader(doc))
	dec.UseNumber()
	var out bytes.Buffer
	if err := elideValue(dec, &out, limit); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("elide: trailing data after the document")
	}
	return out.Bytes(), nil
}

func elideValue(dec *json.Decoder, out *bytes.Buffer, limit int) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	return writeToken(dec, out, tok, limit)
}

func writeToken(dec *json.Decoder, out *bytes.Buffer, tok json.Token, limit int) error {
	switch v := tok.(type) {
	case json.Delim:
		switch v {
		case '{':
			out.WriteByte('{')
			for first := true; dec.More(); first = false {
				if !first {
					out.WriteByte(',')
				}
				kt, err := dec.Token()
				if err != nil {
					return err
				}
				key, _ := kt.(string)
				writeString(out, key)
				out.WriteByte(':')
				vt, err := dec.Token()
				if err != nil {
					return err
				}
				if s, ok := vt.(string); ok && elidedFields[key] && len(s) > limit {
					out.WriteString("null,")
					writeString(out, key+"Bytes")
					fmt.Fprintf(out, ":%d,", len(s))
					writeString(out, key+"Head")
					out.WriteByte(':')
					writeString(out, domain.Truncate(s, headBytes))
					continue
				}
				if err := writeToken(dec, out, vt, limit); err != nil {
					return err
				}
			}
			if _, err := dec.Token(); err != nil { // '}'
				return err
			}
			out.WriteByte('}')
		case '[':
			out.WriteByte('[')
			for first := true; dec.More(); first = false {
				if !first {
					out.WriteByte(',')
				}
				if err := elideValue(dec, out, limit); err != nil {
					return err
				}
			}
			if _, err := dec.Token(); err != nil { // ']'
				return err
			}
			out.WriteByte(']')
		}
	case string:
		writeString(out, v)
	case json.Number:
		out.WriteString(v.String())
	case bool:
		fmt.Fprint(out, v)
	case nil:
		out.WriteString("null")
	}
	return nil
}

func writeString(out *bytes.Buffer, s string) {
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	out.Truncate(out.Len() - 1) // the encoder's newline
}

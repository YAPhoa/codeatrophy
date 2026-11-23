package sqlrow

import (
	"database/sql"
	"time"
)

// Value helpers. Timestamps are stored as Unix seconds; a nil pointer is
// NULL.

// ToUnix is the column value of a timestamp.
func ToUnix(t time.Time) int64 { return t.UTC().Unix() }

// FromUnix is the timestamp of a column value, in UTC.
func FromUnix(s int64) time.Time { return time.Unix(s, 0).UTC() }

// NullUnix is the column value of an optional timestamp.
func NullUnix(p *time.Time) any {
	if p == nil {
		return nil
	}
	return ToUnix(*p)
}

// NullStr is the column value of an optional string.
func NullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// NullInt is the column value of an optional integer.
func NullInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

// StrPtr is the optional string of a nullable column.
func StrPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	s := ns.String
	return &s
}

// IntPtr is the optional integer of a nullable column.
func IntPtr(ni sql.NullInt64) *int {
	if !ni.Valid {
		return nil
	}
	v := int(ni.Int64)
	return &v
}

// TimePtr is the optional timestamp of a nullable column.
func TimePtr(n sql.NullInt64) *time.Time {
	if !n.Valid {
		return nil
	}
	t := FromUnix(n.Int64)
	return &t
}

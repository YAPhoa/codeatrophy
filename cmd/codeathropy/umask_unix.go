//go:build unix

package main

import "syscall"

// restrictUmask makes files the server creates (database, key) readable by
// their owner only.
func restrictUmask() { syscall.Umask(0o077) }

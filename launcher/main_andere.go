//go:build !windows

package main

import (
	"fmt"
	"os"
)

// Start.exe ist nur für Windows gedacht. Diese Datei hält das Paket auf anderen Systemen baubar (Tests).
func main() {
	fmt.Fprintln(os.Stderr, "Start.exe läuft nur unter Windows. Unter Linux/macOS: node start.js")
	os.Exit(2)
}

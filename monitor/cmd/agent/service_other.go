//go:build !windows

package main

func runService(_ string) (bool, error) { return false, nil }

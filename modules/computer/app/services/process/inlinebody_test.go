package process

import "testing"

func TestInlineCommandBodiesAreNotRetained(t *testing.T) {
	for _, command := range []string{
		"printf first\n\nprintf second",
		"python3 -c 'print(42)'",
		"python3 -B -c 'print(42)'",
		"python3 -Bc 'print(42)'",
		"python3 -W ignore -c 'print(42)'",
		"/usr/bin/node -e 'console.log(42)'",
		"pwd && bash -c 'echo 42'",
		"cat <<EOF\nprivate fixture\nEOF",
	} {
		result := ProjectAuditCommand(command, identity).excerpt
		if result.State != "withheld" || result.Reason != "inline_body" || result.Text != "" {
			t.Fatalf("inline command retained: %#v", result)
		}
	}
	for _, command := range []string{"pwd", "git status --short", "git config user.name"} {
		result := ProjectAuditCommand(command, identity).excerpt
		if result.State != "filtered" || result.Text != command {
			t.Fatalf("ordinary command not retained: %#v", result)
		}
	}
}

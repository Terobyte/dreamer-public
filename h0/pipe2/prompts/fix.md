`dreamer check` refused your room `{{ROOM}}`. Fix every finding below and send the WHOLE fragment
again as ONE json object in a ```json fenced block, no prose after it.

This is a fresh request: no conversation history is attached. Everything you need is here.

## Your current fragment
```json
{{PARTIAL}}
```

## Findings of your room (other rooms' findings are not shown and not yours to fix)
{{FINDINGS}}

## The skeleton you build inside
{{SKELETON}}

## Engine spec (format, checks, author loop)
{{SPEC}}

Keep the ids you already have where you can, keep asset prompts unchanged, and only change what the
findings ask for.

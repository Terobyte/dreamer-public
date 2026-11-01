The engine built room `{{ROOM}}` without generated assets: every asset is a placeholder box, so judge
LAYOUT only - positions, sizes, rotations, what is missing, what collides, light placement.

Attached: first the reference frames of your room (reference i was shot from camera
`{{ROOM}}_ref<i>`), then the screenshots of your own cameras (`{{ROOM}}_*`). Compare each screenshot
with its reference: shape, colours, materials, furniture, sizes, what stands where. A screenshot that
looks nothing like its reference is a finding, even when the check is green.
Objects of another room seen through an opening are not yours.

## Your current fragment
```json
{{PARTIAL}}
```

## `dreamer check` report
{{REPORT}}

## The skeleton you build inside
{{SKELETON}}

Report findings only about your own objects, then send the WHOLE fragment again as ONE json object in
a ```json fenced block, no prose after it. Keep the asset prompts exactly as they are: a changed
prompt would regenerate an asset that is already on its way.

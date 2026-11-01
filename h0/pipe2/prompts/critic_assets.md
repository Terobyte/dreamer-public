The engine built room `{{ROOM}}` with the generated assets. Judge the room as it now looks: materials,
colours, scale of the meshes, whether an asset came out wrong.

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

Send the WHOLE fragment again as ONE json object in a ```json fenced block, no prose after it.

Asset prompts are frozen: whatever you write there is ignored and the old prompt is restored. If ONE
asset is clearly unusable, add `"reissue": true` to it and the engine regenerates it from your new
prompt. You get one reissue for this room - spend it only if the asset is beyond saving.

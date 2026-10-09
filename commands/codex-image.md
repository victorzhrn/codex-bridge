---
description: Generate or edit an image with Codex and show the result
argument-hint: '<what the image should show> [-> output/path.png]'
allowed-tools: Read, Glob, mcp__codex-bridge__codex_generate_image, mcp__codex-bridge__codex_edit_image
---

Produce an image for the user.

Request: `$ARGUMENTS`

Steps:

1. Work out where the file goes. If the request contains `->`, the text after it is the output path. Otherwise pick a sensible one inside the current project (`public/`, `assets/`, or `docs/images/` if any of them exist) and say which you chose.
2. Decide whether this is a new image or an edit of an existing one. If the request names an existing image file, or asks to change something about a picture already in the project, call `mcp__codex-bridge__codex_edit_image` — when editing, spell out the invariants in the instruction ("change only X; keep composition, size and everything else identical"), because an unstated invariant is one the model is free to alter.
3. Otherwise call `mcp__codex-bridge__codex_generate_image`. Turn the user's request into a specific visual brief: subject, style, palette, composition, and any text that must appear. A vague prompt returns a generic picture. Choose `size` from the use case — landscape for OG images and banners, square for icons and avatars, portrait for posters. Set `transparent: true` for logos and icons that will sit on a colored surface.
4. The call takes 30 to 110 seconds. When it returns a path, Read that file so you can actually see what came back.
5. Show the user the image and say in one line what you made. If it does not match what they asked for, say so plainly rather than presenting it as a success — then offer to regenerate with a corrected brief.

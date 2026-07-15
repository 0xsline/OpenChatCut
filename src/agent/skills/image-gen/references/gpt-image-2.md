# gpt-image-2 (OpenAI)

Read this document before generating images with `--model gpt-image-2`.

## Capabilities

- Best text rendering among all image models — legible headlines, labels, packaging, UI mockups
- Strongest prompt adherence — follows complex layout and composition instructions precisely
- Max 10 reference images
- Supports `--quality` param: `auto | low | medium | high` (default: `high`)

## Params

| Param       | Values                          | Default | Notes                               |
| ----------- | ------------------------------- | ------- | ----------------------------------- |
| `--quality` | `auto`, `low`, `medium`, `high` | `high`  | Only model with quality control     |
| `--size`    | `1K`, `2K`, `4K`                | `1K`    | 2K/4K are EXPERIMENTAL, higher cost |
| `--aspect`  | 10 ratios (see SKILL.md)        | `16:9`  | Computed to exact pixel dimensions  |
| `--input`   | file path or `asset://<id>`     | —       | Up to 10 references                 |

## When to Use

- Text-heavy images: titles, logos, infographics, UI screenshots
- Prompt-sensitive layouts: precise positioning, composition, or style adherence
- Product mockups, packaging, or any design with readable text
- When fidelity to the prompt matters more than matching reference images

## When NOT to Use

- When reference-image fidelity is critical (use `nano-banana` instead)
- When >10 reference images are needed (use `nano-banana`)
- When speed matters and quality is secondary (nano-banana is faster for simple prompts)

## Prompt Tips

- Be specific about text content: quote exact strings to render (e.g., `"a poster with the headline 'Summer Sale 2026'"`)
- Describe spatial layout explicitly: "centered title at the top, product image below, price tag in the bottom-right corner"
- For multi-element compositions, describe each element's position relative to others
- Include style descriptors: "flat design", "photorealistic", "watercolor", "3D render"
- Specify background explicitly when it matters: "on a pure white background", "against a gradient from blue to purple"
- For text-on-image edits with `--input`, describe what to change and what to keep: "replace the text on the sign with 'Hello World', keep everything else the same"

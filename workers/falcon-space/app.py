"""
Lingonect — Falcon-H1 on a Hugging Face ZeroGPU Space.

Runs tiiuae/Falcon-H1-7B-Instruct (multilingual, Arabic among its 18 training
languages). Falcon-H1-Arabic is not published on Hugging Face; if TII grants
access, set MODEL_ID in the Space settings to switch.

Upload this file and requirements.txt to a private Gradio Space with
"ZeroGPU" hardware. The Cloudflare worker (workers/falcon-worker.js) calls the
`chat` API endpoint below with an HF token, so every request counts against
the token owner's ZeroGPU quota (PRO: ~25 GPU-minutes a day).

API: chat(messages_json: str, temperature: float, max_tokens: int) -> str
  messages_json is an OpenAI-style list: [{"role": "system"|"user"|"assistant",
  "content": "..."}]
"""
import json
import os

import gradio as gr
import spaces
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

# Both can be changed in the Space's Settings → "Variables and secrets"
# without touching this file: MODEL_ID (variable) and HF_TOKEN (secret, needed
# when the model is gated — accept its terms on the model page first).
MODEL_ID = os.environ.get("MODEL_ID", "tiiuae/Falcon-H1-7B-Instruct").strip()
HF_TOKEN = os.environ.get("HF_TOKEN") or None

# If loading fails, keep the app up and show the error on the page (and in
# API replies) instead of crashing the Space with a bare "Runtime error".
LOAD_ERROR = None
tokenizer = model = None
try:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, token=HF_TOKEN)
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.bfloat16, token=HF_TOKEN)
    # ZeroGPU: moving to "cuda" at import time is allowed; the GPU is only
    # really attached while a @spaces.GPU function runs.
    model.to("cuda")
    model.eval()
except Exception:
    import traceback
    LOAD_ERROR = traceback.format_exc()
    print(LOAD_ERROR, flush=True)


@spaces.GPU(duration=60)
def chat(messages_json: str, temperature: float = 0.3, max_tokens: int = 1024) -> str:
    if LOAD_ERROR:
        raise gr.Error("Model failed to load:\n" + LOAD_ERROR[-1500:])
    messages = json.loads(messages_json)
    if not isinstance(messages, list) or not messages:
        raise gr.Error("messages must be a non-empty list")

    inputs = tokenizer.apply_chat_template(
        messages, add_generation_prompt=True, return_tensors="pt", return_dict=True
    ).to("cuda")

    max_new = max(1, min(int(max_tokens or 1024), 2048))
    temp = float(temperature or 0)
    gen_kwargs = {"max_new_tokens": max_new, "pad_token_id": tokenizer.eos_token_id}
    if temp > 0:
        gen_kwargs.update(do_sample=True, temperature=temp, top_p=0.9)
    else:
        gen_kwargs.update(do_sample=False)

    with torch.no_grad():
        out = model.generate(**inputs, **gen_kwargs)
    new_tokens = out[0][inputs["input_ids"].shape[1]:]
    return tokenizer.decode(new_tokens, skip_special_tokens=True).strip()


# gr.Blocks with an explicit api_name on the event: the API route stays
# /gradio_api/call/chat across Gradio 4, 5 and 6.
with gr.Blocks(title="Falcon-H1 (Lingonect)") as demo:
    gr.Markdown(f"## {MODEL_ID} (Lingonect)")
    if LOAD_ERROR:
        gr.Markdown("### ⚠️ The model failed to load. Copy this error and send it on:")
        gr.Code(LOAD_ERROR, language=None)
    messages_box = gr.Textbox(
        label="messages (JSON)", lines=6,
        value='[{"role": "user", "content": "Translate to Arabic: Good morning"}]',
    )
    temperature_box = gr.Slider(0, 1, value=0.3, step=0.05, label="temperature")
    max_tokens_box = gr.Slider(16, 2048, value=1024, step=16, label="max_tokens")
    run_btn = gr.Button("Submit", variant="primary")
    reply_box = gr.Textbox(label="reply")
    run_btn.click(
        chat,
        inputs=[messages_box, temperature_box, max_tokens_box],
        outputs=reply_box,
        api_name="chat",
    )

# ssr_mode=False: Gradio 6 server-side rendering leaves the page unstyled
# inside private Spaces; the API is unaffected either way.
demo.queue(default_concurrency_limit=1).launch(ssr_mode=False)

"""
Lingonect — Falcon-H1-Arabic on a Hugging Face ZeroGPU Space.

Upload this file and requirements.txt to a private Gradio Space with
"ZeroGPU" hardware. The Cloudflare worker (workers/falcon-worker.js) calls the
`chat` API endpoint below with an HF token, so every request counts against
the token owner's ZeroGPU quota (PRO: ~25 GPU-minutes a day).

API: chat(messages_json: str, temperature: float, max_tokens: int) -> str
  messages_json is an OpenAI-style list: [{"role": "system"|"user"|"assistant",
  "content": "..."}]
"""
import json

import gradio as gr
import spaces
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_ID = "tiiuae/Falcon-H1-Arabic-7B-Instruct"

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
# ZeroGPU: moving to "cuda" at import time is allowed; the GPU is only really
# attached while a @spaces.GPU function runs.
model.to("cuda")
model.eval()


@spaces.GPU(duration=60)
def chat(messages_json: str, temperature: float = 0.3, max_tokens: int = 1024) -> str:
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


demo = gr.Interface(
    fn=chat,
    inputs=[
        gr.Textbox(label="messages (JSON)", lines=6,
                   value='[{"role": "user", "content": "Translate to Arabic: Good morning"}]'),
        gr.Slider(0, 1, value=0.3, step=0.05, label="temperature"),
        gr.Slider(16, 2048, value=1024, step=16, label="max_tokens"),
    ],
    outputs=gr.Textbox(label="reply"),
    title="Falcon-H1-Arabic-7B-Instruct (Lingonect)",
    api_name="chat",
)

demo.queue(default_concurrency_limit=1).launch()

import json
import os
import re
from typing import Any, Dict, List, Optional, cast

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, stream_with_context
from openai import OpenAI

load_dotenv()

app = Flask(__name__)

POLLINATIONS_BASE_URL = os.getenv("POLLINATIONS_BASE_URL", "https://gen.pollinations.ai").rstrip("/")
POLLINATIONS_MODEL = os.getenv("POLLINATIONS_MODEL", "openai-fast")
POLLINATIONS_API_KEY = os.getenv("POLLINATIONS_API_KEY")
MAX_HISTORY_MESSAGES = int(os.getenv("MAX_HISTORY_MESSAGES", "30"))

SYSTEM_PROMPT = """You are \"What If? Scenario Explorer\" — a world-class speculative fiction and alternate history AI.

Your purpose is to take any \"What if...\" scenario from the user and transform it into an immersive, highly detailed, branching narrative exploration.

Core Rules:
- Always respond in engaging, vivid, novel-like prose with rich descriptions and emotional depth.
- Structure every response clearly:
  1. Immediate short-term consequences (first days/weeks/months)
  2. Medium-term effects (1-10 years)
  3. Long-term / generational impacts (decades to centuries)
  4. Ripple effects on society, technology, economy, geopolitics, culture, and individual lives
  5. Key branching points where the timeline could diverge further
- Be intellectually honest: Mention uncertainties and plausible alternatives where relevant.
- Make it exciting, thought-provoking, and slightly dramatic.
- Keep responses long and detailed (800–2000+ words when appropriate) but well-formatted with headings, bullet points, and clear paragraphs.
- End every response with 3–5 specific \"Continue exploring...\" suggestions.
- Maintain full consistency across the entire conversation. Remember and build upon all previous details.
- Tone: Intelligent, curious, masterful storyteller — a mix of historian, futurist, and bestselling sci-fi author.
"""


def sanitize_api_key(raw_key: Any) -> Optional[str]:
    if not isinstance(raw_key, str):
        return None

    cleaned = raw_key.strip()
    if not cleaned:
        return None

    return cleaned


def get_openai_client(override_api_key: Optional[str] = None) -> OpenAI:
    api_key = override_api_key or POLLINATIONS_API_KEY
    if not api_key:
        raise RuntimeError("Missing Pollinations API key. Set POLLINATIONS_API_KEY or enter your own key in the app.")
    return OpenAI(api_key=api_key, base_url=f"{POLLINATIONS_BASE_URL}/v1")


def sanitize_messages(raw_messages: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_messages, list):
        return []

    valid_messages: List[Dict[str, str]] = []
    for message in raw_messages:
        if not isinstance(message, dict):
            continue

        role = message.get("role")
        content = message.get("content")

        if role not in {"user", "assistant"}:
            continue
        if not isinstance(content, str) or not content.strip():
            continue

        valid_messages.append({"role": role, "content": content.strip()})

    return valid_messages[-MAX_HISTORY_MESSAGES:]


def build_completion_messages(history: List[Dict[str, str]]) -> List[Dict[str, str]]:
    return [{"role": "system", "content": SYSTEM_PROMPT}, *history]


def extract_suggestions(text: str) -> List[str]:
    suggestions: List[str] = []
    seen = set()

    for line in text.splitlines():
        cleaned = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
        cleaned = cleaned.strip("*_` ")
        if not cleaned:
            continue

        if cleaned.lower().startswith("continue exploring"):
            normalized = re.sub(r"\s+", " ", cleaned)
            key = normalized.lower()
            if key not in seen:
                suggestions.append(normalized)
                seen.add(key)

    if len(suggestions) >= 3:
        return suggestions[:5]

    fallback = [
        "Continue exploring the most fragile political fault line in this timeline.",
        "Continue exploring how ordinary families adapt over the next 5 years.",
        "Continue exploring the technological winners, losers, and ethical flashpoints.",
        "Continue exploring a surprising geopolitical alliance that forms next.",
        "Continue exploring the emotional arc of one individual living through this reality.",
    ]

    for item in fallback:
        key = item.lower()
        if key not in seen:
            suggestions.append(item)
            seen.add(key)
        if len(suggestions) >= 5:
            break

    return suggestions[:5]


def collect_text_from_delta(delta_content: Any) -> str:
    if isinstance(delta_content, str):
        return delta_content

    if isinstance(delta_content, list):
        parts: List[str] = []
        for item in delta_content:
            if isinstance(item, str):
                parts.append(item)
                continue

            if isinstance(item, dict):
                text_value = item.get("text")
                if isinstance(text_value, str):
                    parts.append(text_value)
                    continue

                nested = item.get("content")
                if isinstance(nested, str):
                    parts.append(nested)

        return "".join(parts)

    return ""


def stream_chat_events(history: List[Dict[str, str]], user_api_key: Optional[str] = None):
    client = get_openai_client(user_api_key)
    messages = cast(Any, build_completion_messages(history))

    stream = client.chat.completions.create(
        model=POLLINATIONS_MODEL,
        messages=messages,
        temperature=0.9,
        stream=True,
    )

    full_text_parts: List[str] = []

    for chunk in stream:
        if not chunk.choices:
            continue

        delta = chunk.choices[0].delta
        text_chunk = collect_text_from_delta(delta.content)

        if text_chunk:
            full_text_parts.append(text_chunk)
            yield "chunk", {"text": text_chunk}

    full_text = "".join(full_text_parts)
    suggestions = extract_suggestions(full_text)
    yield "done", {"full_text": full_text, "suggestions": suggestions}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/chat", methods=["POST"])
def chat_once():
    payload = request.get_json(silent=True) or {}
    history = sanitize_messages(payload.get("messages", []))
    user_api_key = sanitize_api_key(payload.get("user_api_key"))

    if not history:
        return jsonify({"error": "No valid messages were provided."}), 400

    try:
        client = get_openai_client(user_api_key)
        completion_messages = cast(Any, build_completion_messages(history))
        completion = client.chat.completions.create(
            model=POLLINATIONS_MODEL,
            messages=completion_messages,
            temperature=0.9,
            stream=False,
        )

        response_text = completion.choices[0].message.content or ""
        suggestions = extract_suggestions(response_text)
        return jsonify({"text": response_text, "suggestions": suggestions})

    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 500


@app.route("/api/chat/stream", methods=["POST"])
def chat_stream():
    payload = request.get_json(silent=True) or {}
    history = sanitize_messages(payload.get("messages", []))
    user_api_key = sanitize_api_key(payload.get("user_api_key"))

    if not history:
        return jsonify({"error": "No valid messages were provided."}), 400

    def event_stream():
        try:
            for event_name, event_data in stream_chat_events(history, user_api_key):
                yield f"event: {event_name}\n"
                yield f"data: {json.dumps(event_data)}\n\n"
        except Exception as exc:  # noqa: BLE001
            error_payload = {"message": str(exc)}
            yield "event: error\n"
            yield f"data: {json.dumps(error_payload)}\n\n"

    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return cast(Any, stream_with_context(event_stream())), 200, headers


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)

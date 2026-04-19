const chatPanel = document.getElementById("chatPanel");
const chatFeed = document.getElementById("chatFeed");
const scenarioInput = document.getElementById("scenarioInput");
const exploreBtn = document.getElementById("exploreBtn");
const continueBtn = document.getElementById("continueBtn");
const newScenarioBtn = document.getElementById("newScenarioBtn");
const statusText = document.getElementById("statusText");
const supportApiKeyInput = document.getElementById("supportApiKeyInput");

const state = {
    messages: [],
    loading: false,
    abortController: null,
    userApiKey: "",
};

const CONTINUE_PROMPT = "Continue exploring this exact timeline. Preserve full continuity, advance causality, and introduce fresh branching points with concrete consequences.";

marked.setOptions({
    breaks: true,
    gfm: true,
});

function setStatus(message, tone = "normal") {
    statusText.textContent = message;

    const toneMap = {
        normal: "text-indigo-200/70",
        live: "text-cyan-200",
        success: "text-emerald-200",
        danger: "text-rose-200",
    };

    statusText.className = `text-xs ${toneMap[tone] ?? toneMap.normal}`;
}

function scrollToBottom() {
    chatFeed.scrollTop = chatFeed.scrollHeight;
}

function createMessageShell(role) {
    const wrapper = document.createElement("article");
    wrapper.className = "rise-in";

    const row = document.createElement("div");
    row.className = role === "user" ? "flex justify-end" : "flex justify-start";

    const bubble = document.createElement("div");
    bubble.className = role === "user"
        ? "max-w-[92%] rounded-2xl rounded-br-sm border border-fuchsia-300/40 bg-fuchsia-500/14 px-4 py-3 text-sm text-fuchsia-50 sm:max-w-[80%]"
        : "max-w-[95%] rounded-2xl rounded-bl-sm border border-cyan-300/45 bg-cyan-500/12 px-4 py-3 text-sm text-cyan-50 sm:max-w-[86%]";

    if (role === "assistant") {
        bubble.classList.add("message-markdown");
    }

    row.appendChild(bubble);
    wrapper.appendChild(row);
    chatFeed.appendChild(wrapper);
    scrollToBottom();

    return { wrapper, bubble };
}

function renderMarkdown(target, markdownText) {
    const rendered = marked.parse(markdownText || "");
    target.innerHTML = DOMPurify.sanitize(rendered);
}

function addSuggestions(parent, suggestions) {
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
        return;
    }

    const suggestionRow = document.createElement("div");
    suggestionRow.className = "mt-3 flex flex-wrap gap-2";

    suggestions.slice(0, 5).forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "suggestion-chip rounded-lg px-3 py-1.5 text-xs font-semibold";
        button.textContent = item;
        button.addEventListener("click", () => submitScenario(item));
        suggestionRow.appendChild(button);
    });

    parent.appendChild(suggestionRow);
    scrollToBottom();
}

function appendUserMessage(text) {
    const { bubble } = createMessageShell("user");
    bubble.textContent = text;
}

function createAssistantStreamBubble() {
    const { bubble, wrapper } = createMessageShell("assistant");
    bubble.innerHTML = '<div class="flex items-center gap-2 text-cyan-100/85"><span class="pulse-dot"></span><span>Synthesizing timeline...</span></div>';
    return { bubble, wrapper };
}

function parseSSEEvent(rawChunk) {
    const lines = rawChunk.split("\n");
    let event = "message";
    let data = "";

    lines.forEach((line) => {
        if (line.startsWith("event:")) {
            event = line.slice(6).trim();
        }
        if (line.startsWith("data:")) {
            data += line.slice(5).trim();
        }
    });

    if (!data) {
        return null;
    }

    try {
        return {
            event,
            payload: JSON.parse(data),
        };
    } catch {
        return null;
    }
}

async function streamAssistantResponse(bubble, wrapper) {
    const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            messages: state.messages,
            user_api_key: state.userApiKey || undefined,
        }),
        signal: state.abortController.signal,
    });

    if (!response.ok) {
        let message = "Unable to reach the scenario engine.";
        try {
            const detail = await response.json();
            message = detail.error || message;
        } catch {
            // Ignore parse failures and keep fallback message.
        }
        throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let assistantText = "";
    let suggestions = [];

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes("\n\n")) {
            const boundaryIndex = buffer.indexOf("\n\n");
            const rawEvent = buffer.slice(0, boundaryIndex).trim();
            buffer = buffer.slice(boundaryIndex + 2);

            if (!rawEvent) {
                continue;
            }

            const parsed = parseSSEEvent(rawEvent);
            if (!parsed) {
                continue;
            }

            if (parsed.event === "chunk") {
                const textChunk = parsed.payload.text || "";
                assistantText += textChunk;
                renderMarkdown(bubble, assistantText);
                scrollToBottom();
            }

            if (parsed.event === "done") {
                assistantText = parsed.payload.full_text || assistantText;
                suggestions = Array.isArray(parsed.payload.suggestions) ? parsed.payload.suggestions : [];
                renderMarkdown(bubble, assistantText);
                addSuggestions(wrapper, suggestions);
                scrollToBottom();
            }

            if (parsed.event === "error") {
                const message = parsed.payload.message || "Unknown stream error.";
                throw new Error(message);
            }
        }
    }

    if (!assistantText.trim()) {
        assistantText = "No response text was returned by the model.";
        renderMarkdown(bubble, assistantText);
    }

    state.messages.push({ role: "assistant", content: assistantText });
}

async function submitScenario(text) {
    const prompt = (text || "").trim();
    if (!prompt || state.loading) {
        return;
    }

    state.userApiKey = supportApiKeyInput?.value?.trim() || "";

    state.loading = true;
    continueBtn.disabled = true;
    exploreBtn.disabled = true;

    chatPanel.classList.remove("hidden");
    appendUserMessage(prompt);
    state.messages.push({ role: "user", content: prompt });

    scenarioInput.value = "";
    setStatus(
        state.userApiKey
            ? "Generating alternate timeline with your Pollinations key..."
            : "Generating alternate timeline...",
        "live",
    );

    const { bubble, wrapper } = createAssistantStreamBubble();
    state.abortController = new AbortController();

    try {
        await streamAssistantResponse(bubble, wrapper);
        setStatus("Timeline expanded successfully.", "success");
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error.";
        bubble.innerHTML = `<p class="text-rose-100">${DOMPurify.sanitize(message)}</p>`;
        setStatus(message, "danger");
    } finally {
        state.loading = false;
        continueBtn.disabled = state.messages.length === 0;
        exploreBtn.disabled = false;
    }
}

function resetScenario() {
    if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
    }

    state.messages = [];
    state.loading = false;
    chatFeed.innerHTML = "";
    chatPanel.classList.add("hidden");
    continueBtn.disabled = true;
    exploreBtn.disabled = false;
    scenarioInput.value = "";
    scenarioInput.focus();
    setStatus("Ready to explore a new reality.", "normal");
}

exploreBtn.addEventListener("click", () => {
    submitScenario(scenarioInput.value);
});

continueBtn.addEventListener("click", () => {
    submitScenario(CONTINUE_PROMPT);
});

newScenarioBtn.addEventListener("click", resetScenario);

scenarioInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        submitScenario(scenarioInput.value);
    }
});

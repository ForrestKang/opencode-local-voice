// Native OpenCode settings panel body for the voice-input tab.
// The module is embedded into OpenCode's Settings bundle and receives the
// actual Solid primitives and controls through props.ui.
function __ocVoiceNativeSettingsV2(props) {
  const ui = props.ui;
  const systemDefaultMicrophone = "__oc_voice_system_default__";
  const [config, setConfig] = ui.createSignal(null);
  const [microphone, setMicrophone] = ui.createSignal("");
  const [devices, setDevices] = ui.createSignal([]);
  const [loading, setLoading] = ui.createSignal(true);
  const [hasConfig, setHasConfig] = ui.createSignal(false);
  const [saving, setSaving] = ui.createSignal(false);
  const [warming, setWarming] = ui.createSignal(false);
  const [errorText, setErrorText] = ui.createSignal("");
  const [runtimeText, setRuntimeText] = ui.createSignal("正在读取语音设置…");
  const [vocabularyText, setVocabularyText] = ui.createSignal("");
  const [replacementText, setReplacementText] = ui.createSignal("");
  const [rewriteKey, setRewriteKey] = ui.createSignal("");
  const [clearRewriteKey, setClearRewriteKey] = ui.createSignal(false);
  const [rewriteTestBusy, setRewriteTestBusy] = ui.createSignal(false);
  const [rewriteTestText, setRewriteTestText] = ui.createSignal("");
  const [vocabularyStatus, setVocabularyStatus] = ui.createSignal("");
  const [draftActionText, setDraftActionText] = ui.createSignal("");
  let disposed = false;
  let readRun = 0;

  const defaults = {
    backend: "auto",
    device: "auto",
    model_path: "",
    language: "auto",
    beam_size: 1,
    cpu_threads: 4,
    max_seconds: 120,
    idle_seconds: 1800,
    warmup_on_record: true,
    initial_prompt: "",
    text_mode: "clean",
    punctuation_mode: "auto",
    space_mode: "preserve",
    vocabulary_preset: "coding",
    vocabulary: [],
    replacements: [],
    prompt_template: "{text}",
    rewrite_base_url: "",
    rewrite_model: "",
    rewrite_prompt: "",
    rewrite_timeout: 15,
    rewrite_key_configured: false,
  };
  const languageOptions = [
    { value: "auto", label: "自动检测" },
    { value: "zh", label: "中文" },
    { value: "en", label: "English" },
  ];
  const backendOptions = [
    { value: "auto", label: "自动选择" },
    { value: "faster-whisper", label: "faster-whisper" },
    { value: "mlx", label: "MLX（Apple Silicon）" },
  ];
  const deviceOptions = [
    { value: "auto", label: "自动选择" },
    { value: "cuda", label: "CUDA" },
    { value: "cpu", label: "CPU" },
  ];
  const textModeOptions = [
    { value: "original", label: "原文" },
    { value: "clean", label: "轻度整理" },
    { value: "coding-prompt", label: "编程任务" },
    { value: "analysis-prompt", label: "问题分析" },
    { value: "custom", label: "自定义模板" },
    { value: "ai", label: "AI 改写" },
  ];
  const punctuationOptions = [
    { value: "auto", label: "自动" },
    { value: "zh", label: "中文标点" },
    { value: "en", label: "英文标点" },
    { value: "none", label: "保持原标点" },
  ];
  const spaceOptions = [
    { value: "preserve", label: "保持空格" },
    { value: "smart", label: "智能整理" },
    { value: "space-to-comma", label: "空格转逗号" },
    { value: "comma-to-space", label: "逗号转空格" },
  ];
  const vocabularyPresetOptions = [
    { value: "none", label: "不使用词表" },
    { value: "coding", label: "编程词表" },
  ];
  const savingDisabled = () => loading() || saving() || !hasConfig();

  function api() {
    const client = window.ocMic || window.ocVoiceTransport;
    if (!client) throw new Error("语音服务未连接");
    return client;
  }

  function unwrap(value) {
    if (value && value.error) {
      const detail = typeof value.error === "string" ? value.error : value.error.message;
      throw Object.assign(new Error(detail || "语音服务请求失败"), { code: value.code });
    }
    return value;
  }

  function failureMessage(error) {
    const message = String((error && error.message) || error || "");
    if (error && error.code === "VOICE_VALIDATION") return message.slice(0, 180);
    if (/ECONNREFUSED|Failed to fetch|服务未连接|服务未启动/i.test(message)) return "语音服务暂不可用，请重试";
    if (/timeout|超时/i.test(message)) return "请求超时，请重试";
    if (/配置写入失败|配置无效|模型目录不能为空|请填写已下载模型|invalid|validation/i.test(message)) return message.slice(0, 180);
    return "请求失败，请检查语音服务后重试";
  }

  function normalizedConfig(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const safeInput = { ...input };
    delete safeInput.rewrite_api_key;
    return { ...defaults, ...safeInput };
  }

  function applyConfig(value) {
    const next = normalizedConfig(value);
    setConfig(next);
    setVocabularyText(Array.isArray(next.vocabulary) ? next.vocabulary.join("\n") : "");
    setReplacementText(Array.isArray(next.replacements) ? next.replacements.map((item) => `${item.from} => ${item.to}`).join("\n") : "");
    setRewriteKey("");
    setClearRewriteKey(false);
    if (typeof props.onConfig === "function") props.onConfig(next);
  }

  function currentValue(name) {
    const value = config();
    return value ? value[name] : defaults[name];
  }

  function setField(name, value) {
    setConfig((current) => ({ ...normalizedConfig(current), [name]: value }));
  }

  function optionFor(options, value) {
    const found = options.find((item) => item.value === value);
    if (found) return found;
    if (value == null || value === "") return options[0];
    return { value: String(value), label: String(value) + "（当前设置）" };
  }

  function createSection(title, children) {
    const section = ui.template('<div class="settings-v2-section"><h3 class="settings-v2-section-title"></h3><div></div>')();
    ui.insert(section.firstChild, () => title);
    ui.insert(section.lastChild, ui.createComponent(ui.SettingsListV2, {
      get children() { return children; },
    }));
    return section;
  }

  function createAdvancedSection(children) {
    const section = ui.template('<details class="settings-v2-section" data-oc-voice-advanced><summary class="settings-v2-section-title">高级识别设置</summary><div data-oc-voice-advanced-list></div></details>')();
    const list = section.querySelector('[data-oc-voice-advanced-list]');
    ui.insert(list, ui.createComponent(ui.SettingsListV2, {
      get children() { return children; },
    }));
    return section;
  }

  function createCollapsibleSection(title, testId, children) {
    const section = ui.template('<details class="settings-v2-section"><summary class="settings-v2-section-title"></summary><div></div></details>')();
    section.dataset.ocVoiceSection = testId;
    ui.insert(section.querySelector("summary"), () => title);
    ui.insert(section.lastChild, ui.createComponent(ui.SettingsListV2, {
      get children() { return children; },
    }));
    return section;
  }

  function createRow(title, description, children) {
    return ui.createComponent(ui.SettingsRowV2, {
      get title() { return title; },
      get description() { return description || ""; },
      get children() { return children; },
    });
  }

  function selectControl(id, title, description, options, value, onSelect) {
    return createRow(title, description, ui.createComponent(ui.SelectV2, {
      appearance: "inline",
      "data-testid": id,
      get disabled() { return savingDisabled(); },
      get options() { return options(); },
      get current() { return optionFor(options(), value()); },
      value: (option) => option.value,
      label: (option) => option.label,
      onSelect: (option) => { if (option) onSelect(option.value); },
    }));
  }

  function inputControl(id, title, description, name, inputOptions) {
    const options = inputOptions || {};
    return createRow(title, description, ui.createComponent(ui.TextInputV2, {
      id,
      type: options.type || "text",
      min: options.min,
      max: options.max,
      step: options.step,
      maxLength: options.maxlength,
      spellcheck: options.spellcheck === true,
      autocomplete: "off",
      "aria-label": title,
      placeholder: options.placeholder || "",
      get disabled() { return savingDisabled(); },
      get value() {
        const value = currentValue(name);
        return value == null ? "" : String(value);
      },
      onInput: (event) => setField(name, event.currentTarget.value),
    }));
  }

  function textFieldControl(id, title, description, name, getValue, onValue, fieldOptions) {
    const options = fieldOptions || {};
    return createRow(title, description, ui.createComponent(ui.TextField, {
      id,
      name,
      label: title,
      hideLabel: true,
      multiline: true,
      rows: options.rows || 3,
      maxLength: options.maxLength,
      placeholder: options.placeholder || "",
      "data-testid": id,
      get disabled() { return savingDisabled(); },
      get value() { return String(getValue() || ""); },
      onChange: (value) => onValue(String(value == null ? "" : value)),
    }));
  }

  function actionButton(id, label, onClick, variant, isBusy) {
    return ui.createComponent(ui.ButtonV2, {
      type: "button",
      id,
      "data-testid": id,
      variant: variant || "neutral",
      size: "normal",
      get disabled() { return savingDisabled() || Boolean(isBusy && isBusy()); },
      onClick,
      get children() { return typeof label === "function" ? label() : label; },
    });
  }

  function createButtonGroup(buttons) {
    const group = ui.template('<div class="flex flex-wrap gap-2"></div>')();
    ui.insert(group, buttons);
    return group;
  }

  function statusTextNode(testId, getValue) {
    const node = ui.template('<p class="text-12-regular text-v2-text-text-muted" role="status" aria-live="polite"></p>')();
    if (testId) node.dataset.testid = testId;
    ui.insert(node, getValue);
    return node;
  }

  function parseVocabularyRows(text) {
    const rows = String(text || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (rows.length > 100) throw Object.assign(new Error("自定义词汇最多 100 项"), { code: "VOICE_VALIDATION" });
    if (rows.some((item) => item.length > 80)) throw Object.assign(new Error("单条自定义词汇最多 80 个字符"), { code: "VOICE_VALIDATION" });
    if (Array.from(new Set(rows)).reduce((total, item) => total + Array.from(item).length, 0) > 4096) throw Object.assign(new Error("自定义词汇总长度最多 4096 个字符"), { code: "VOICE_VALIDATION" });
    return rows;
  }

  function parseReplacementRows(text) {
    const rows = String(text || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (rows.length > 100) throw Object.assign(new Error("纠错规则最多 100 条"), { code: "VOICE_VALIDATION" });
    const sources = new Set();
    const replacements = rows.map((line) => {
      const parts = line.split("=>");
      if (parts.length !== 2 || !parts[0].trim()) {
        throw Object.assign(new Error("纠错规则请按“错误写法 => 正确写法”填写"), { code: "VOICE_VALIDATION" });
      }
      const from = parts[0].trim(), to = parts[1].trim();
      if (from.length > 80 || to.length > 80) throw Object.assign(new Error("纠错规则的单侧最多 80 个字符"), { code: "VOICE_VALIDATION" });
      if (sources.has(from)) throw Object.assign(new Error("纠错规则的错误写法不能重复"), { code: "VOICE_VALIDATION" });
      sources.add(from);
      return { from, to };
    });
    if (replacements.reduce((total, item) => total + Array.from(item.from).length + Array.from(item.to).length, 0) > 8192) throw Object.assign(new Error("纠错规则总长度最多 8192 个字符"), { code: "VOICE_VALIDATION" });
    return replacements;
  }

  function buildConfig() {
    const textMode = String(currentValue("text_mode") || "clean");
    const allowedTextModes = ["original", "clean", "coding-prompt", "analysis-prompt", "custom", "ai"];
    if (!allowedTextModes.includes(textMode)) throw Object.assign(new Error("请选择有效的文本处理模式"), { code: "VOICE_VALIDATION" });
    const punctuationMode = String(currentValue("punctuation_mode") || "auto");
    if (!["auto", "zh", "en", "none"].includes(punctuationMode)) throw Object.assign(new Error("请选择有效的标点模式"), { code: "VOICE_VALIDATION" });
    const spaceMode = String(currentValue("space_mode") || "preserve");
    if (!["preserve", "smart", "space-to-comma", "comma-to-space"].includes(spaceMode)) throw Object.assign(new Error("请选择有效的空格处理模式"), { code: "VOICE_VALIDATION" });
    const vocabularyPreset = String(currentValue("vocabulary_preset") || "coding");
    if (!["none", "coding"].includes(vocabularyPreset)) throw Object.assign(new Error("请选择有效的词表"), { code: "VOICE_VALIDATION" });
    const template = String(currentValue("prompt_template") || "");
    if (template.length > 6000) throw Object.assign(new Error("自定义模板最多 6000 个字符"), { code: "VOICE_VALIDATION" });
    if ((template.match(/\{text\}/g) || []).length !== 1) {
      throw Object.assign(new Error("自定义模板必须且只能包含一次 {text}"), { code: "VOICE_VALIDATION" });
    }
    const rewriteBaseUrl = String(currentValue("rewrite_base_url") || "").trim();
    const rewriteModel = String(currentValue("rewrite_model") || "").trim();
    const rewritePrompt = String(currentValue("rewrite_prompt") || "");
    if (rewriteBaseUrl.length > 2048) throw Object.assign(new Error("AI 接口地址最多 2048 个字符"), { code: "VOICE_VALIDATION" });
    if (rewriteModel.length > 256) throw Object.assign(new Error("AI 模型名称最多 256 个字符"), { code: "VOICE_VALIDATION" });
    if (rewritePrompt.length > 4000) throw Object.assign(new Error("AI 改写提示最多 4000 个字符"), { code: "VOICE_VALIDATION" });
    if (textMode === "ai" && (!rewriteBaseUrl || !rewriteModel)) throw Object.assign(new Error("请填写 AI 兼容接口地址和模型名称"), { code: "VOICE_VALIDATION" });
    return {
      backend: String(currentValue("backend") || "auto"),
      device: String(currentValue("device") || "auto"),
      model_path: String(currentValue("model_path") || "").trim(),
      language: String(currentValue("language") || "auto"),
      beam_size: numberValue("beam_size", 1, 5),
      cpu_threads: numberValue("cpu_threads", 1, 128),
      max_seconds: numberValue("max_seconds", 5, 300),
      idle_seconds: numberValue("idle_seconds", 30, 86400),
      warmup_on_record: Boolean(currentValue("warmup_on_record")),
      initial_prompt: String(currentValue("initial_prompt") || ""),
      text_mode: textMode,
      punctuation_mode: punctuationMode,
      space_mode: spaceMode,
      vocabulary_preset: vocabularyPreset,
      vocabulary: parseVocabularyRows(vocabularyText()),
      replacements: parseReplacementRows(replacementText()),
      prompt_template: template,
      rewrite_base_url: rewriteBaseUrl,
      rewrite_model: rewriteModel,
      rewrite_prompt: rewritePrompt,
      rewrite_timeout: numberValue("rewrite_timeout", 5, 60),
    };
  }

  function numberValue(name, minimum, maximum) {
    const value = Number(currentValue(name));
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      const labels = { max_seconds: "最长录音", beam_size: "解码宽度", cpu_threads: "CPU 线程数", idle_seconds: "模型空闲释放", rewrite_timeout: "AI 请求超时" };
      throw Object.assign(new Error((labels[name] || name) + "必须在 " + minimum + " 到 " + maximum + " 之间"), { code: "VOICE_VALIDATION" });
    }
    return value;
  }

  function statusDescription(status) {
    const rawState = String(status && (status.model_state || status.state) || "").toLowerCase();
    const stateLabels = {
      ready: "模型已就绪",
      loaded: "模型已就绪",
      idle: "模型未加载",
      unloaded: "模型未加载",
      loading: "正在加载模型",
      warming: "正在预热模型",
      error: "模型加载失败",
      failed: "模型加载失败",
    };
    const state = stateLabels[rawState] || (rawState ? "语音服务已连接" : "语音服务已连接");
    const rawDevice = String(status && status.device || "").toLowerCase();
    const deviceLabels = {
      cuda: "GPU / CUDA",
      gpu: "GPU",
      cpu: "CPU",
      mps: "Apple GPU / Metal",
      metal: "Apple GPU / Metal",
    };
    const device = deviceLabels[rawDevice] || (rawDevice ? String(status.device) : "");
    return device ? state + " · " + device : state;
  }

  async function readSettings() {
    if (disposed || saving()) return;
    const run = ++readRun;
    setLoading(true);
    setHasConfig(false);
    setErrorText("");
    setRuntimeText("正在读取语音设置…");
    try {
      const value = unwrap(await api().getConfig());
      if (disposed || run !== readRun) return;
      applyConfig(value);
      setHasConfig(true);
      setLoading(false);
      try {
        const client = api();
        if (typeof client.status === "function") {
          const status = unwrap(await client.status());
          if (!disposed && run === readRun) setRuntimeText(statusDescription(status));
        } else {
          setRuntimeText("语音设置已读取");
        }
      } catch (_) {
        if (!disposed && run === readRun) setRuntimeText("语音设置已读取，服务状态暂不可用");
      }
    } catch (error) {
      if (!disposed && run === readRun) {
        setLoading(false);
        setRuntimeText("无法读取语音设置");
        setErrorText(failureMessage(error));
      }
    }
  }

  async function enumerateMicrophones() {
    if (disposed || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") return;
    try {
      const items = await navigator.mediaDevices.enumerateDevices();
      if (disposed) return;
      setDevices(items.filter((item) => item.kind === "audioinput" && item.deviceId).map((item, index) => ({
        value: item.deviceId,
        label: item.label || "麦克风 " + (index + 1),
      })));
    } catch (_) {
      // Device enumeration can be unavailable before permission is granted.
      // Opening Settings must never request microphone permission.
    }
  }

  async function refreshStatus() {
    try {
      const client = api();
      if (typeof client.status === "function") {
        const status = unwrap(await client.status());
        if (!disposed) setRuntimeText(statusDescription(status));
      } else if (!disposed) setRuntimeText("语音服务已连接");
    } catch (_) {
      if (!disposed) setRuntimeText("语音设置已保存，服务状态暂不可用");
    }
  }

  function optionalRewriteKey() {
    if (clearRewriteKey()) return "";
    const key = String(rewriteKey() || "");
    return key.trim() ? key : undefined;
  }

  async function testRewriteConnection() {
    if (disposed || rewriteTestBusy() || savingDisabled()) return;
    setErrorText("");
    setRewriteTestText("正在测试连接…");
    setRewriteTestBusy(true);
    try {
      const overrides = buildConfig();
      if (!overrides.rewrite_base_url || !overrides.rewrite_model) {
        throw Object.assign(new Error("请填写 AI 兼容接口地址和模型名称"), { code: "VOICE_VALIDATION" });
      }
      const result = unwrap(await api().testRewrite(overrides, optionalRewriteKey()));
      if (!disposed) setRewriteTestText(result && result.ok ? "连接测试成功" : "连接测试未通过，请检查接口配置");
    } catch (error) {
      if (!disposed) setRewriteTestText(failureMessage(error));
    } finally {
      if (!disposed) setRewriteTestBusy(false);
    }
  }

  function importVocabularyFile(file) {
    if (disposed || saving()) return;
    void (async () => {
      try {
        if (!file || file.size > 65536) throw Object.assign(new Error("词表 JSON 文件不能超过 64 KB"), { code: "VOICE_VALIDATION" });
        const parsed = JSON.parse(await file.text());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Object.assign(new Error("词表 JSON 格式无效"), { code: "VOICE_VALIDATION" });
        const allowed = ["schema", "version", "vocabulary_preset", "vocabulary", "replacements"];
        if (Object.keys(parsed).some((key) => !allowed.includes(key))) throw Object.assign(new Error("词表 JSON 含不支持的字段"), { code: "VOICE_VALIDATION" });
        if (parsed.schema !== "opencode-local-voice/vocabulary" || parsed.version !== 1) throw Object.assign(new Error("词表 JSON 版本不受支持"), { code: "VOICE_VALIDATION" });
        if (!["none", "coding"].includes(parsed.vocabulary_preset)) throw Object.assign(new Error("词表 JSON 的 preset 无效"), { code: "VOICE_VALIDATION" });
        if (!Array.isArray(parsed.vocabulary) || !Array.isArray(parsed.replacements)) throw Object.assign(new Error("词表 JSON 缺少词汇或纠错规则"), { code: "VOICE_VALIDATION" });
        if (parsed.vocabulary.some((item) => typeof item !== "string")) throw Object.assign(new Error("词表 JSON 的 vocabulary 必须是字符串数组"), { code: "VOICE_VALIDATION" });
        if (parsed.replacements.some((item) => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => key !== "from" && key !== "to") || typeof item.from !== "string" || typeof item.to !== "string")) {
          throw Object.assign(new Error("词表 JSON 的纠错规则格式无效"), { code: "VOICE_VALIDATION" });
        }
        const vocabText = parsed.vocabulary.join("\n");
        const replaceText = parsed.replacements.map((item) => `${item.from} => ${item.to}`).join("\n");
        parseVocabularyRows(vocabText);
        parseReplacementRows(replaceText);
        setField("vocabulary_preset", parsed.vocabulary_preset);
        setField("vocabulary", parsed.vocabulary);
        setField("replacements", parsed.replacements);
        setVocabularyText(vocabText);
        setReplacementText(replaceText);
        setErrorText("");
        setVocabularyStatus("词表已导入；保存后生效");
      } catch (error) {
        if (!disposed) { setVocabularyStatus(""); setErrorText(failureMessage(error)); }
      }
    })();
  }

  function exportVocabularyFile() {
    if (disposed) return;
    try {
      const preset = String(currentValue("vocabulary_preset") || "coding");
      if (!["none", "coding"].includes(preset)) throw Object.assign(new Error("请选择有效的词表"), { code: "VOICE_VALIDATION" });
      const data = {
        schema: "opencode-local-voice/vocabulary",
        version: 1,
        vocabulary_preset: preset,
        vocabulary: parseVocabularyRows(vocabularyText()),
        replacements: parseReplacementRows(replacementText()),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "opencode-local-voice-vocabulary.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setErrorText("");
      setVocabularyStatus("词表 JSON 已导出");
    } catch (error) {
      setErrorText(failureMessage(error));
    }
  }

  function performDraftAction(action) {
    const successMessages = {
      insertComma: "已插入逗号",
      insertSpace: "已插入空格",
      spaceToComma: "已将文字中的空格转换为逗号",
      commaToSpace: "已将文字中的逗号转换为空格",
    };
    try {
      const client = window.ocVoiceDraftActions;
      if (!client || typeof client.perform !== "function") throw new Error("文本工具暂不可用");
      const result = client.perform(action);
      if (result && result.ok) setDraftActionText(successMessages[action] || "文字操作已完成");
      else setDraftActionText("未执行：" + (result && result.error ? String(result.error).slice(0, 200) : "请先选择需要处理的文本"));
    } catch (_) {
      setDraftActionText("文本工具暂不可用");
    }
  }

  function restoreDraft(which) {
    try {
      const client = window.ocVoiceDraftActions;
      const method = which === "original" ? "restoreOriginal" : "restoreLocal";
      if (!client || typeof client[method] !== "function") throw new Error("文本工具暂不可用");
      const result = client[method]();
      if (result && result.ok) setDraftActionText(which === "original" ? "已恢复原始识别文本" : "已恢复本地处理文本");
      else setDraftActionText("未执行：" + (result && result.error ? String(result.error).slice(0, 200) : "没有可恢复的语音结果"));
    } catch (_) {
      setDraftActionText("文本工具暂不可用");
    }
  }

  async function saveSettings() {
    if (disposed || loading() || saving() || !hasConfig()) return;
    setSaving(true);
    setErrorText("");
    try {
      const value = buildConfig();
      if (!value.model_path) throw Object.assign(new Error("请填写已下载模型的目录"), { code: "VOICE_VALIDATION" });
      if (value.initial_prompt.length > 2048) throw Object.assign(new Error("技术词与识别提示最多 2048 个字符"), { code: "VOICE_VALIDATION" });
      const pendingKey = String(rewriteKey() || "");
      if (clearRewriteKey()) value.rewrite_api_key = "";
      else if (pendingKey.trim()) value.rewrite_api_key = pendingKey;
      const result = unwrap(await api().saveConfig(value));
      if (disposed) return;
      try {
        const storage = window.localStorage;
        if (microphone()) storage.setItem("oc-voice-microphone", microphone());
        else storage.removeItem("oc-voice-microphone");
      } catch (_) {}
      applyConfig(result);
      setRuntimeText("配置已保存，下次录音使用新设置");
      setRewriteTestText("");
      void refreshStatus();
    } catch (error) {
      if (!disposed) setErrorText(failureMessage(error));
    } finally {
      if (!disposed) setSaving(false);
    }
  }

  async function warmup() {
    if (disposed || loading() || saving() || warming()) return;
    setWarming(true);
    setErrorText("");
    try {
      unwrap(await api().warmup());
      if (!disposed) setRuntimeText("已开始预热模型，可以返回对话使用");
    } catch (error) {
      if (!disposed) setRuntimeText("预热未完成，仍可尝试录音");
    } finally {
      if (!disposed) setWarming(false);
    }
  }

  function makeSelectOptions(baseOptions, configName) {
    return () => {
      const value = currentValue(configName);
      if (baseOptions.some((option) => option.value === value) || !value) return baseOptions;
      return [...baseOptions, { value: String(value), label: String(value) + "（当前设置）" }];
    };
  }

  function microphoneOptions() {
    const options = [{ value: systemDefaultMicrophone, label: "系统默认麦克风" }, ...devices()];
    const selected = microphone();
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({ value: selected, label: "已保存的麦克风（当前不可用）" });
    }
    return options;
  }

  const root = ui.template('<div id="oc-voice-settings" data-oc-voice-native="true"><div class="settings-v2-tab-header"><h2 class="settings-v2-tab-title">语音输入</h2><p id="oc-voice-runtime" class="text-12-regular text-v2-text-text-muted" role="status" aria-live="polite"></p></div><div class="settings-v2-tab-body"><div data-oc-voice-main-sections></div><details class="settings-v2-section" data-oc-voice-advanced><summary class="settings-v2-section-title">高级识别设置</summary><div data-oc-voice-advanced-list></div></details><div class="settings-v2-section" data-oc-voice-footer><p id="oc-voice-settings-error" class="text-12-regular text-v2-text-text-muted" role="alert"></p><div class="flex flex-wrap justify-end gap-2" data-oc-voice-actions></div></div></div></div>')();
  const mainSections = root.querySelector("[data-oc-voice-main-sections]");
  const advancedList = root.querySelector("[data-oc-voice-advanced-list]");
  const errorNode = root.querySelector("#oc-voice-settings-error");
  const runtimeNode = root.querySelector("#oc-voice-runtime");
  const actionsNode = root.querySelector("[data-oc-voice-actions]");
  let vocabularyFileInput = null;
  const rewriteTestStatus = ui.template('<p class="text-12-regular text-v2-text-text-muted" role="status" aria-live="polite"></p>')();
  ui.insert(rewriteTestStatus, rewriteTestText);
  const draftActionStatus = statusTextNode("oc-voice-draft-action-status", draftActionText);
  const rewriteKeyStatus = statusTextNode("oc-voice-rewrite-key-status", () => Boolean(currentValue("rewrite_key_configured")) ? "已保存密钥（不会回显）" : "尚未保存密钥");
  const vocabularyStatusNode = statusTextNode("oc-voice-vocabulary-status", vocabularyStatus);
  const customTemplateRow = createRow("自定义模板", "模板必须且只能包含一次 {text}，它会被本次识别文字替换", textFieldControl(
    "oc-voice-prompt-template", "自定义模板", "", "prompt_template", () => currentValue("prompt_template"), (value) => setField("prompt_template", value), { rows: 3, maxLength: 6000, placeholder: "填写本地模板，包含 {text}" }
  ));
  const customTemplateSection = ui.createComponent(ui.Show, {
    get when() { return currentValue("text_mode") === "custom"; },
    get children() { return customTemplateRow; },
  });
  const textProcessing = createSection("文本处理", [
    selectControl("oc-voice-text-mode", "处理模式", "选择原文、轻度整理、本地模板或可选 AI 改写", () => textModeOptions, () => currentValue("text_mode"), (value) => setField("text_mode", value)),
    selectControl("oc-voice-punctuation-mode", "标点", "只处理本次语音结果", () => punctuationOptions, () => currentValue("punctuation_mode"), (value) => setField("punctuation_mode", value)),
    selectControl("oc-voice-space-mode", "空格处理", "普通键盘空格不受影响；这里只整理语音结果", () => spaceOptions, () => currentValue("space_mode"), (value) => setField("space_mode", value)),
    customTemplateSection,
    createRow("固定录音操作", "Enter 结束录音；Esc 取消。开始录音请点麦克风按钮，普通空格保持原行为。", ""),
  ]);

  const vocabularySection = createSection("词表与模板", [
    selectControl("oc-voice-vocabulary-preset", "内置词表", "编程词表仅作为识别提示，不会进行激进的近音替换", () => vocabularyPresetOptions, () => currentValue("vocabulary_preset"), (value) => setField("vocabulary_preset", value)),
    createRow("词表文件", "只导入／导出词表、preset 与纠错规则；不包含 AI 地址或密钥。", createButtonGroup([
      actionButton("oc-voice-vocabulary-import", "导入 JSON", () => vocabularyFileInput && vocabularyFileInput.click(), "neutral"),
      actionButton("oc-voice-vocabulary-export", "导出 JSON", exportVocabularyFile, "ghost"),
    ])),
    createRow("词表状态", "", vocabularyStatusNode),
  ]);
  const vocabularyDetails = createCollapsibleSection("自定义词汇与纠错", "vocabulary", [
    textFieldControl("oc-voice-vocabulary-list", "自定义词汇", "每行一个术语或别名；最多 100 项，每项 80 个字符", "vocabulary", () => vocabularyText(), (value) => setVocabularyText(value), { rows: 5, maxLength: 32768, placeholder: "填写术语或别名，每行一个" }),
    textFieldControl("oc-voice-replacements-list", "纠错对照", "每行一条，格式为 错误写法 => 正确写法", "replacements", () => replacementText(), (value) => setReplacementText(value), { rows: 5, maxLength: 32768, placeholder: "错误写法 => 正确写法" }),
  ]);

  const rewriteKeyControl = createRow("API 密钥", "密钥只写入本机后台，不会回读；留空表示不更改。", ui.createComponent(ui.TextInputV2, {
    id: "oc-voice-rewrite-api-key",
    type: "password",
    maxLength: 2048,
    autocomplete: "new-password",
    "aria-label": "AI API 密钥",
    placeholder: "输入新密钥（不回显已保存密钥）",
    get disabled() { return savingDisabled(); },
    get value() { return rewriteKey(); },
    onInput: (event) => { setRewriteKey(event.currentTarget.value); setClearRewriteKey(false); },
  }));
  const clearKeyButton = actionButton("oc-voice-rewrite-clear-key", () => clearRewriteKey() ? "撤销清除密钥" : "清除已保存密钥", () => {
    if (clearRewriteKey()) {
      setClearRewriteKey(false);
    } else {
      setRewriteKey("");
      setClearRewriteKey(true);
    }
  }, "ghost");
  const rewriteRows = [
    createRow("启用说明", "选择并保存 AI 改写模式后，会发送本次转写文本和改写提示。预览与连接测试仅在点击各自按钮时请求；测试连接只发送固定测试句。", ""),
    inputControl("oc-voice-rewrite-base-url", "兼容 API 地址", "支持 OpenAI 兼容接口", "rewrite_base_url", { type: "url", maxlength: 2048, placeholder: "https://example.com/v1" }),
    inputControl("oc-voice-rewrite-model", "模型名称", "填写服务端提供的模型 ID", "rewrite_model", { maxlength: 256, placeholder: "模型名称" }),
    textFieldControl("oc-voice-rewrite-prompt", "改写提示", "用于 AI 改写的指令", "rewrite_prompt", () => currentValue("rewrite_prompt"), (value) => setField("rewrite_prompt", value), { rows: 3, maxLength: 4000, placeholder: "填写改写要求" }),
    inputControl("oc-voice-rewrite-timeout", "请求超时", "秒，范围 5 到 60", "rewrite_timeout", { type: "number", min: 5, max: 60, step: 1 }),
    rewriteKeyControl,
    createRow("密钥状态", "", rewriteKeyStatus),
    createRow("密钥操作", "清除操作会在保存时生效。", createButtonGroup([clearKeyButton])),
    createRow("连接测试", "手动检查 AI 接口是否可用。", createButtonGroup([
      actionButton("oc-voice-rewrite-test", "测试连接", () => { void testRewriteConnection(); }, "neutral", () => rewriteTestBusy()),
    ])),
    createRow("连接状态", "", rewriteTestStatus),
  ];
  const aiFallback = createRow("AI 改写未启用", "选择“AI 改写”后设置兼容接口；默认不会请求远端服务。", "");
  const aiFields = ui.createComponent(ui.Show, {
    get when() { return currentValue("text_mode") === "ai"; },
    fallback: aiFallback,
    get children() { return rewriteRows; },
  });
  const aiSection = createSection("AI 改写", [aiFields]);

  const draftActions = [
    ["insertComma", "插入逗号"],
    ["insertSpace", "插入空格"],
    ["spaceToComma", "空格转逗号"],
    ["commaToSpace", "逗号转空格"],
  ].map(([action, label]) => actionButton("oc-voice-draft-" + action, label, () => performDraftAction(action), "neutral"));
  const textTools = createCollapsibleSection("文本工具", "text-tools", [
    createRow("固定录音操作", "Enter 结束录音；Esc 取消。这里的转换按钮只处理明确选区或最近插入的语音片段。", ""),
    createRow("插入与转换", "无明确选区且没有最近插入的语音片段时，操作会提示先选择文本。", createButtonGroup(draftActions)),
    createRow("恢复语音文本", "只恢复最近语音片段，不替换其他草稿内容。", createButtonGroup([
      actionButton("oc-voice-restore-original", "恢复原始", () => restoreDraft("original"), "ghost"),
      actionButton("oc-voice-restore-local", "恢复本地结果", () => restoreDraft("local"), "ghost"),
    ])),
    createRow("操作状态", "", draftActionStatus),
  ]);

  const microphoneControl = ui.createComponent(ui.SelectV2, {
    appearance: "inline",
    "data-testid": "oc-voice-microphone",
    get disabled() { return savingDisabled(); },
    get options() { return microphoneOptions(); },
    get current() { return optionFor(microphoneOptions(), microphone() || systemDefaultMicrophone); },
    value: (option) => option.value,
    label: (option) => option.label,
    onSelect: (option) => { if (option) setMicrophone(option.value === systemDefaultMicrophone ? "" : option.value); },
  });
  const languageControl = selectControl("oc-voice-language", "识别语言", "默认自动检测，也可固定为中文或英语", makeSelectOptions(languageOptions, "language"), () => currentValue("language"), (value) => setField("language", value));
  const backendControl = selectControl("oc-voice-backend", "识别后端", "自动选择可用的本地识别后端", makeSelectOptions(backendOptions, "backend"), () => currentValue("backend"), (value) => setField("backend", value));
  const deviceControl = selectControl("oc-voice-device", "计算设备", "自动模式会尝试使用可用的 GPU", makeSelectOptions(deviceOptions, "device"), () => currentValue("device"), (value) => setField("device", value));
  const common = createSection("输入", [
    createRow("麦克风", "选择用于语音输入的麦克风", microphoneControl),
    languageControl,
    inputControl("oc-voice-max-seconds", "最长录音", "秒，达到上限后自动停止并识别", "max_seconds", { type: "number", min: 5, max: 300, step: 1 }),
    createRow("开始录音时预热", "提前加载模型，减少停止录音后的等待", ui.createComponent(ui.Switch, {
      children: "开始录音时预热",
      hideLabel: true,
      "aria-label": "开始录音时预热",
      get disabled() { return savingDisabled(); },
      get checked() { return Boolean(currentValue("warmup_on_record")); },
      onChange: (checked) => setField("warmup_on_record", checked),
    })),
  ]);
  const recognition = createSection("识别", [
    backendControl,
    deviceControl,
    inputControl("oc-voice-model-path", "已下载模型目录", "填写本机已下载的 Whisper 模型目录", "model_path", { type: "text", placeholder: "模型目录路径", maxlength: 1024 }),
  ]);
  const advanced = ui.createComponent(ui.SettingsListV2, {
    get children() {
      return [
        inputControl("oc-voice-beam-size", "解码宽度", "较低的值通常更快", "beam_size", { type: "number", min: 1, max: 5, step: 1 }),
        inputControl("oc-voice-cpu-threads", "CPU 线程数", "CPU 识别时使用的线程数", "cpu_threads", { type: "number", min: 1, max: 128, step: 1 }),
        inputControl("oc-voice-idle-seconds", "模型空闲释放", "秒，空闲一段时间后释放模型内存", "idle_seconds", { type: "number", min: 30, max: 86400, step: 1 }),
        createRow("技术词与识别提示", "帮助识别项目名称和专业词汇", ui.createComponent(ui.TextField, {
          name: "initial_prompt",
          label: "技术词与识别提示",
          hideLabel: true,
          multiline: true,
          rows: 3,
          maxLength: 2048,
          placeholder: "填写项目术语或识别提示",
          get disabled() { return savingDisabled(); },
          get value() { return String(currentValue("initial_prompt") || ""); },
          onChange: (value) => setField("initial_prompt", value),
        })),
      ];
    },
  });
  ui.insert(mainSections, [common, recognition, textProcessing, vocabularySection, vocabularyDetails, aiSection, textTools]);
  const tabBody = mainSections.parentNode;
  while (mainSections.firstChild) tabBody.insertBefore(mainSections.firstChild, mainSections);
  mainSections.remove();
  ui.insert(advancedList, advanced);
  vocabularyFileInput = ui.template('<input type="file" hidden accept=".json,application/json" data-testid="oc-voice-vocabulary-file">')();
  root.appendChild(vocabularyFileInput);

  const reloadButton = ui.createComponent(ui.ButtonV2, {
    type: "button",
    id: "oc-voice-settings-reload",
    variant: "ghost",
    size: "normal",
    get disabled() { return loading() || saving(); },
    onClick: () => { void readSettings(); },
    get children() { return "重新读取"; },
  });
  const warmupButton = ui.createComponent(ui.ButtonV2, {
    type: "button",
    id: "oc-voice-preheat",
    variant: "neutral",
    size: "normal",
    get disabled() { return loading() || saving() || warming() || !hasConfig(); },
    onClick: () => { void warmup(); },
    get children() { return warming() ? "正在预热…" : "预热模型"; },
  });
  const saveButton = ui.createComponent(ui.ButtonV2, {
    type: "button",
    id: "oc-voice-settings-save",
    variant: "neutral",
    size: "normal",
    get disabled() { return loading() || saving() || !hasConfig(); },
    onClick: () => { void saveSettings(); },
    get children() { return saving() ? "正在保存…" : "保存"; },
  });
  ui.insert(actionsNode, [reloadButton, warmupButton, saveButton]);

  ui.insert(errorNode, errorText);
  ui.insert(runtimeNode, runtimeText);

  function loadSavedMicrophone() {
    try { setMicrophone(window.localStorage.getItem("oc-voice-microphone") || ""); } catch (_) {}
  }
  function onVocabularyFileChange(event) {
    const target = event.currentTarget;
    const file = target && target.files && target.files[0];
    if (file) importVocabularyFile(file);
    if (target) target.value = "";
  }
  function onDeviceChange() { void enumerateMicrophones(); }
  ui.onMount(() => {
    loadSavedMicrophone();
    void readSettings();
    void enumerateMicrophones();
    if (vocabularyFileInput) vocabularyFileInput.addEventListener("change", onVocabularyFileChange);
    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    }
  });
  ui.onCleanup(() => {
    disposed = true;
    readRun += 1;
    if (vocabularyFileInput) vocabularyFileInput.removeEventListener("change", onVocabularyFileChange);
    if (navigator.mediaDevices && typeof navigator.mediaDevices.removeEventListener === "function") {
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
    }
  });

  return root;
}

(() => {
  "use strict";

  // School settings. Set nationalIdLength to null to accept any length (1–64).
  const CONFIG = Object.freeze({
    schoolName: "مدارس سما التكنولوجيا للتميز والإبداع",
    logoPath: "./assets/school-logo.jpg",
    nationalIdLength: 10,
    requestTimeoutMs: 15000,
  });

  const MESSAGES = Object.freeze({
    empty: "يرجى إدخال الرقم الوطني أولاً",
    invalid: "يرجى إدخال أرقام إنجليزية فقط",
    length: "يرجى إدخال رقم وطني صحيح",
    found: "تم العثور على الشهادة بنجاح",
    notFound:
      "عذراً، لم يتم العثور على شهادة مرتبطة بالرقم الوطني المدخل. يرجى التأكد من صحة الرقم والمحاولة مرة أخرى.",
    network:
      "تعذر الاتصال حالياً. يرجى التحقق من اتصال الإنترنت والمحاولة مجدداً",
    unexpected: "حدث خطأ أثناء التحقق من الشهادة. يرجى المحاولة مرة أخرى",
    local:
      "يرجى فتح الموقع عبر خادم HTTP محلي أو عبر GitHub Pages لاستخدام البحث.",
  });

  const byId = (id) => document.getElementById(id);
  const form = byId("search-form");
  const input = byId("national-id");
  const searchButton = byId("search-button");
  const inputError = byId("input-error");
  const resultPanel = byId("result-panel");
  const downloadLink = byId("download-link");
  const announcement = byId("announcement");
  let activeRequest = null;
  let generation = 0;
  let currentPdf = null;
  let lastValidInput = "";

  function applySchoolSettings() {
    document.querySelectorAll("[data-school-name]").forEach((node) => {
      node.textContent = CONFIG.schoolName;
    });
    document.querySelectorAll("[data-school-logo]").forEach((node) => {
      node.addEventListener(
        "error",
        () => {
          node.src = "./assets/school-logo.jpg";
        },
        { once: true },
      );
      node.src = CONFIG.logoPath;
    });
    document.title = `${CONFIG.schoolName} | بوابة الاستعلام عن الشهادات`;
    byId("current-year").textContent = String(new Date().getFullYear());
  }

  function setLoading(loading) {
    searchButton.disabled = loading;
    byId("search-spinner").hidden = !loading;
    document.querySelector(".search-button-icon").hidden = loading;
    byId("search-button-label").textContent = loading
      ? "جارٍ البحث..."
      : "بحث عن الشهادة";
    byId("loading-state").hidden = !loading;
    form.setAttribute("aria-busy", String(loading));
  }

  function animateAttention(element) {
    element.classList.remove("attention-shake");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Restart the effect even when the same error appears on a repeated search.
    void element.offsetWidth;
    element.classList.add("attention-shake");
  }

  function setInputError(message = "") {
    inputError.textContent = message;
    inputError.hidden = !message;
    input.setAttribute("aria-invalid", String(Boolean(message)));
    if (message) animateAttention(inputError);
    else inputError.classList.remove("attention-shake");
  }

  function resetSearch() {
    // Both cancellation and a generation guard protect against late responses.
    generation += 1;
    if (activeRequest) {
      activeRequest.controller.abort();
      window.clearTimeout(activeRequest.timer);
      activeRequest = null;
    }
    currentPdf = null;
    resultPanel.hidden = true;
    resultPanel.classList.remove("attention-shake");
    byId("success-actions").hidden = true;
    byId("retry-button").hidden = true;
    downloadLink.removeAttribute("href");
    downloadLink.removeAttribute("download");
    announcement.textContent = "";
    setLoading(false);
  }

  function rejectCharacters() {
    resetSearch();
    setInputError(MESSAGES.invalid);
  }

  function handleInput() {
    resetSearch();
    // Fallback for browsers or input methods without cancelable beforeinput.
    if (/[^0-9]/.test(input.value)) {
      // Reject the edit entirely instead of turning mixed text into another ID.
      input.value = lastValidInput;
      setInputError(MESSAGES.invalid);
      return;
    }
    lastValidInput = input.value;
    setInputError();
  }

  function showResult(state, message) {
    resultPanel.dataset.state = state;
    byId("result-icon-use").setAttribute(
      "href",
      state === "success"
        ? "#i-check"
        : state === "not-found"
          ? "#i-search"
          : "#i-info",
    );
    byId("result-title").textContent =
      state === "success"
        ? MESSAGES.found
        : state === "not-found"
          ? "لم نعثر على شهادتك"
          : "تعذر إتمام البحث";
    byId("result-description").textContent = message;
    byId("success-actions").hidden = state !== "success";
    byId("retry-button").hidden = state === "success";
    resultPanel.hidden = false;
    announcement.textContent = `${byId("result-title").textContent}. ${message}`;
    if (state !== "success") {
      byId("result-title").focus({ preventScroll: true });
      resultPanel.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
      animateAttention(resultPanel);
    }
  }

  function validationMessage(id) {
    if (!id) return MESSAGES.empty;
    if (!/^[0-9]+$/.test(id)) return MESSAGES.invalid;
    if (
      id.length > 64 ||
      (CONFIG.nationalIdLength !== null &&
        id.length !== CONFIG.nationalIdLength)
    )
      return MESSAGES.length;
    return "";
  }

  async function searchPdf(event) {
    event.preventDefault();
    if (activeRequest) return;
    resetSearch();
    setInputError();
    // Keep this a string: converting to a number would destroy leading zeros.
    const id = input.value;
    const error = validationMessage(id);
    if (error) {
      setInputError(error);
      input.focus();
      return;
    }
    if (!["http:", "https:"].includes(window.location.protocol)) {
      showResult("error", MESSAGES.local);
      return;
    }

    const url = new URL(
      `./pdfs/${encodeURIComponent(id)}.pdf`,
      document.baseURI,
    );
    const requestGeneration = generation;
    const controller = new AbortController();
    const request = { controller, timer: null, timedOut: false };
    request.timer = window.setTimeout(() => {
      request.timedOut = true;
      controller.abort();
    }, CONFIG.requestTimeoutMs);
    activeRequest = request;
    setLoading(true);
    announcement.textContent = "جارٍ البحث عن شهادتك، يرجى الانتظار";

    try {
      // HEAD checks metadata only. Never fall back to downloading the PDF.
      const response = await fetch(url.href, {
        method: "HEAD",
        signal: controller.signal,
        mode: "same-origin",
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (requestGeneration !== generation) return;
      if (response.status === 404 || response.status === 410) {
        showResult("not-found", MESSAGES.notFound);
        return;
      }
      const contentType = (response.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const isPdfType = [
        "application/pdf",
        "application/x-pdf",
        "application/octet-stream",
      ].includes(contentType);
      // Reject HTML fallback pages, redirects, empty files and other HTTP errors.
      if (
        response.status !== 200 ||
        response.type === "opaqueredirect" ||
        !isPdfType ||
        response.headers.get("content-length") === "0"
      ) {
        showResult("error", MESSAGES.unexpected);
        return;
      }
      currentPdf = { url: url.href, filename: `${id}.pdf` };
      downloadLink.href = currentPdf.url;
      downloadLink.download = currentPdf.filename;
      showResult(
        "success",
        "شهادتك جاهزة، جارٍ فتحها مباشرة. يمكنك أيضاً تحميل نسخة على جهازك.",
      );
      openCertificate();
    } catch (error) {
      if (requestGeneration !== generation) return;
      if (error.name === "AbortError" && !request.timedOut) return;
      showResult("error", MESSAGES.network);
    } finally {
      window.clearTimeout(request.timer);
      if (requestGeneration === generation) {
        activeRequest = null;
        setLoading(false);
      }
    }
  }

  function openCertificate() {
    if (!currentPdf) return;
    // Same-tab navigation works after async HEAD without popup permissions.
    // Only a URL confirmed by the current search can reach this function.
    window.location.assign(currentPdf.url);
  }

  input.addEventListener("beforeinput", (event) => {
    if (event.cancelable && event.data && /[^0-9]/.test(event.data)) {
      event.preventDefault();
      rejectCharacters();
    }
  });
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text");
    if (text && !/^[0-9]+$/.test(text)) {
      event.preventDefault();
      rejectCharacters();
    }
  });
  input.addEventListener("input", handleInput);
  form.addEventListener("submit", searchPdf);
  byId("view-button").addEventListener("click", openCertificate);
  byId("retry-button").addEventListener("click", () => {
    resetSearch();
    setInputError();
    input.focus();
    input.select();
  });
  // Restoring a page from the back-forward cache must not restore an old result.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      resetSearch();
      setInputError();
    }
  });
  window.addEventListener("pagehide", resetSearch);
  applySchoolSettings();
})();

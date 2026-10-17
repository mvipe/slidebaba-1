// Where a question's number goes, decided once for Notes, Slides and the Studio preview.
//
// The splitter stores a question's printed label ("1.", "Q7", "प्रश्न 3") as the item's
// `title` and the question itself as `text`. Shown as a heading, the number sat alone on a
// line above its question. Every view now puts it IN FRONT of the question instead:
// "1. एक अभाज्य संख्या में …".

// A printed question label: "1", "12.", "Q7", "Q.7", "Qn. 4", "Q. No. 5", "Que. 6",
// "Question No. 7", "प्रश्न 3", "प्र. 3", "प्रश्न सं. 8", "प्र.सं. 9", "(iv)", "(क)", "3)".
const LABEL_WORD = String.raw`(?:प्रश्न\s*(?:सं(?:ख्या)?\.?)?|प्र\.?\s*(?:सं\.?)?|सवाल|Q(?:n|ue|ues|uestion)?\.?\s*(?:No\.?|Num(?:ber)?\.?)?)`;
export const QUESTION_LABEL_RE = new RegExp(String.raw`^(?:${LABEL_WORD}\s*)?[([]?\s*(?:\d+|[ivxlc]+|[a-z]|[क-ह])\s*[)\].:]?$`, "iu");

/**
 * "1" -> "1.", "प्रश्न 3" -> "प्रश्न 3." ; a label that already has punctuation stays exactly
 * as printed ("Qn. 4", "Q.7", "3)", "(iv)").
 */
export const asLabel = (t) => (/\d$/.test(t) && !/[.):\]]/.test(t) ? `${t}.` : t);

/**
 * Split an item into what each view needs:
 *   label  "1." when the title is a printed question number, else ""
 *   title  a real heading to keep (e.g. "Snippet 2", an instruction block's name), else ""
 *   text   the question
 * A title that is just the question's own first words is dropped — it would print twice.
 */
export function questionParts(item) {
  const title = String(item?.title || "").trim();
  const text = String(item?.text || "");
  if (title && QUESTION_LABEL_RE.test(title)) return { label: asLabel(title), title: "", text };
  if (title && text.trim().startsWith(title.replace(/…$/, ""))) return { label: "", title: "", text };
  return { label: "", title, text };
}

/** The item with its number moved into the text: { title: "", text: "1. एक अभाज्य…" }. */
export function inlineQuestion(item) {
  const p = questionParts(item);
  return { ...item, title: p.title, text: p.label ? `${p.label} ${p.text}` : p.text };
}

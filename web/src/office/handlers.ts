// Office.js commands the shell runs on behalf of the tool iframe.
// Only the shell loads Office.js; tools call these through exec() in bridge/officeHost.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OfficeApp } from "../bridge/officeHost";

declare const Office: any;
declare const Word: any;
declare const Excel: any;

type Handler = (payload: any) => Promise<unknown>;

function asyncCall<T>(fn: (cb: (r: any) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((r) => (r.status === Office.AsyncResultStatus.Succeeded ? resolve(r.value as T) : reject(new Error(r.error?.message || "Office-fejl")))),
  );
}

function text(payload: any): string {
  const t = payload?.text;
  if (typeof t !== "string") throw new Error("text mangler");
  return t;
}

// ── Shared (Word, Excel, PowerPoint) ───────────────────────────────────────

const shared: Record<string, Handler> = {
  GET_DOCUMENT_INFO: async () => ({ url: Office.context.document?.url ?? null, mode: Office.context.document?.mode ?? null }),
  GET_SELECTION: async () =>
    asyncCall<string>((cb) => Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, cb)),
  INSERT_TEXT: async (payload) =>
    asyncCall((cb) => Office.context.document.setSelectedDataAsync(text(payload), { coercionType: Office.CoercionType.Text }, cb)),
};

// ── Word ───────────────────────────────────────────────────────────────────

const word: Record<string, Handler> = {
  ...shared,
  GET_SELECTION: () =>
    Word.run(async (ctx: any) => {
      const sel = ctx.document.getSelection();
      sel.load("text");
      await ctx.sync();
      return sel.text as string;
    }),
  WORD_GET_PARAGRAPHS: (payload) =>
    Word.run(async (ctx: any) => {
      const ps = ctx.document.body.paragraphs;
      ps.load("items/text,items/style");
      await ctx.sync();
      return ps.items.slice(0, payload?.limit ?? 200).map((p: any, i: number) => ({ index: i, text: p.text, style: p.style }));
    }),
  WORD_GET_TEXT: () =>
    Word.run(async (ctx: any) => {
      const body = ctx.document.body;
      body.load("text");
      await ctx.sync();
      return body.text as string;
    }),
  INSERT_TEXT: (payload) =>
    Word.run(async (ctx: any) => {
      ctx.document.getSelection().insertText(text(payload), "Replace");
      await ctx.sync();
      return true;
    }),
  WORD_INSERT_PARAGRAPH: (payload) =>
    Word.run(async (ctx: any) => {
      const where = payload?.location === "Start" ? "Start" : "End";
      ctx.document.body.insertParagraph(text(payload), where);
      await ctx.sync();
      return true;
    }),
  WORD_ADD_COMMENT: (payload) =>
    Word.run(async (ctx: any) => {
      ctx.document.getSelection().insertComment(text(payload));
      await ctx.sync();
      return true;
    }),
};

// ── Excel / PowerPoint ─────────────────────────────────────────────────────

const excel: Record<string, Handler> = {
  ...shared,
  INSERT_TEXT: (payload) =>
    Excel.run(async (ctx: any) => {
      const cell = ctx.workbook.getActiveCell();
      cell.values = [[text(payload)]];
      await ctx.sync();
      return true;
    }),
};

const powerpoint: Record<string, Handler> = { ...shared };

// ── Outlook ────────────────────────────────────────────────────────────────

function item() {
  const it = Office.context.mailbox?.item;
  if (!it) throw new Error("Ingen mail er åben");
  return it;
}

const isCompose = () => typeof item().body?.setSelectedDataAsync === "function" && typeof item().subject?.setAsync === "function";

const outlook: Record<string, Handler> = {
  OUTLOOK_GET_CONTEXT: async () => ({
    compose: isCompose(),
    itemType: item().itemType,
    user: Office.context.mailbox.userProfile?.displayName ?? null,
  }),
  OUTLOOK_READ_ITEM: async () => {
    const it = item();
    const compose = isCompose();
    const subject = compose ? await asyncCall<string>((cb) => it.subject.getAsync(cb)) : it.subject;
    const body = await asyncCall<string>((cb) => it.body.getAsync(Office.CoercionType.Text, cb));
    const from = compose ? null : it.from ? `${it.from.displayName} <${it.from.emailAddress}>` : null;
    return { subject, body, from, compose, date: compose ? null : it.dateTimeCreated?.toISOString?.() ?? null };
  },
  INSERT_TEXT: async (payload) => {
    if (!isCompose()) throw new Error("Åbn en mail, du skriver, for at indsætte tekst");
    return asyncCall((cb) => item().body.setSelectedDataAsync(text(payload), { coercionType: Office.CoercionType.Text }, cb));
  },
  OUTLOOK_PREPEND_BODY: async (payload) => {
    if (!isCompose()) throw new Error("Åbn en mail, du skriver, for at indsætte tekst");
    return asyncCall((cb) => item().body.prependAsync(text(payload), { coercionType: Office.CoercionType.Text }, cb));
  },
  OUTLOOK_SET_SUBJECT: async (payload) => {
    if (!isCompose()) throw new Error("Emnet kan kun ændres, når du skriver en mail");
    return asyncCall((cb) => item().subject.setAsync(text(payload).slice(0, 255), cb));
  },
  OUTLOOK_OPEN_REPLY: async (payload) => {
    const it = item();
    const html = text(payload).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
    if (payload?.all) it.displayReplyAllForm(html);
    else it.displayReplyForm(html);
    return true;
  },
};

export const HANDLERS: Record<OfficeApp, Record<string, Handler>> = {
  word,
  excel,
  powerpoint,
  outlook,
  unknown: {},
};

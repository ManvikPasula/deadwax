import "server-only";

import { env } from "@/lib/env";

/**
 * Outbound mail. Three messages, one transport, and no way for a caller to compose anything.
 *
 * THE CATALOGUE IS THE SECURITY MODEL. A caller picks one of the three exported functions and
 * supplies a recipient, a username and a link. It cannot supply headers, a sender, a reply-to,
 * a subject or a body. That removes header injection and template injection AS A CLASS rather
 * than filtering for them, and it is the reason there is no general `sendEmail(options)` here —
 * the general function is the vulnerability, and adding it later is the regression to watch
 * for.
 *
 * RECIPIENTS COME FROM THE DATABASE, NEVER FROM A REQUEST. Every caller reads the address off
 * the `users` row (or off the token row, which was bound to an address at issue). A flow that
 * mails an address a request supplied is a mail relay with our sending reputation attached —
 * which is also why the admin reset action reads the address from the row rather than from the
 * form the admin was looking at.
 *
 * TEXT ONLY, NO HTML PART. Links are clickable in every modern client, so the HTML part would
 * buy styling and cost us a templating step over interpolated values and a place for a
 * tracking pixel to appear. The app ships no third-party script anywhere else either; this is
 * the same decision applied to mail.
 *
 * WITH NO PROVIDER CONFIGURED IT LOGS AND REPORTS `via: "log"`. Logged rather than dropped for
 * two reasons: a developer can complete the confirmation and reset flows with no account
 * anywhere, and a missing provider in production is VISIBLE IN THE LOGS instead of looking
 * like success. Read the consequence carefully — `delivered: true` does not mean the member
 * received anything. The UI must branch on `via === "resend"` (or on
 * `emailDeliveryConfigured()`) and say so.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Ten seconds. Mail is sent from inside a Server Action that a member is waiting on, so the
 * failure mode to avoid is a hung request, not a missed send: the token row is already
 * committed, and every one of these flows has a "send it again" button.
 */
const DELIVERY_TIMEOUT_MS = 10_000;

export type EmailVia = "resend" | "log";

export type EmailResult = {
  /** True also for `via: "log"`. See the module docblock — this is not a receipt. */
  delivered: boolean;
  via: EmailVia;
};

/** The closed set of things this module can send. Used only for logging and tests. */
export type EmailKind = "verification" | "password-reset" | "admin-password-reset";

type Message = {
  to: string;
  subject: string;
  text: string;
  kind: EmailKind;
};

/**
 * True when a provider key is present, i.e. when mail will actually leave the building.
 *
 * The UI uses this to tell the truth: *"No email provider is configured — the reset link was
 * written to the server log instead of being sent."* A flow that claimed "check your inbox"
 * with no provider would leave somebody waiting for mail that was never sent, which is a worse
 * outcome than the awkward sentence.
 */
export function emailDeliveryConfigured(): boolean {
  return Boolean(env.resendApiKey);
}

/**
 * Refuses CR and LF. DEFENCE IN DEPTH, on top of the structural defence above.
 *
 * A newline in a header value is how you append a header — a second `Bcc:`, a second
 * `Content-Type` — and while nothing here lets a caller reach a header directly, `to` and
 * `subject` are the two fields that become headers downstream. This runs anyway, because the
 * structural defence is a property of today's call sites and this is a property of the data.
 *
 * IT THROWS RATHER THAN STRIPPING. Stripping would quietly send a mail with a mangled subject
 * and leave no trace of the attempt; throwing surfaces as a failed action and a stack in the
 * log, which is the correct outcome for something that should be impossible. The throw is
 * caught by `guard()` and reported as the flat "Something went wrong. Try again."
 */
export function assertSingleLine(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Refusing to send mail: ${field} contains a line break.`);
  }
  return value;
}

/**
 * The single transport. Private on purpose — see the module docblock.
 *
 * The failure log carries THE STATUS AND THE MESSAGE KIND AND NOTHING ELSE. Not the response
 * body, because a provider's error body commonly echoes the request it rejected, which here
 * means the recipient address and the link — and a link is a bearer token. Not the recipient
 * either: hosted logs are readable by anyone with project access, and there is no operational
 * question that the address answers and the kind does not.
 */
async function deliver(message: Message): Promise<EmailResult> {
  assertSingleLine(message.to, "recipient");
  assertSingleLine(message.subject, "subject");

  const key = env.resendApiKey;
  if (!key) {
    console.info(
      [
        "",
        "──────────────────────────────────────────────────────────────",
        `[email:log] ${message.kind} — no RESEND_API_KEY, nothing was sent`,
        `To:      ${message.to}`,
        `From:    ${env.emailFrom}`,
        `Subject: ${message.subject}`,
        "──────────────────────────────────────────────────────────────",
        message.text,
        "──────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return { delivered: true, via: "log" };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error("[email] delivery refused", { kind: message.kind, status: response.status });
      return { delivered: false, via: "resend" };
    }
    return { delivered: true, via: "resend" };
  } catch (error) {
    // A timeout or a DNS failure. The name is the whole diagnostic worth keeping: a
    // `TimeoutError` means the provider is slow, anything else means the network is.
    console.error("[email] delivery failed", {
      kind: message.kind,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { delivered: false, via: "resend" };
  }
}

/**
 * The link is asserted single-line for a different reason than the recipient is: it goes in the
 * body, not a header, but a link split across two lines is a link nobody can click, and every
 * one of these mails exists solely to carry one.
 */
function assertLink(url: string): string {
  return assertSingleLine(url, "link");
}

/** How a member is addressed. Falls back to the username; there is no "Dear User". */
function greeting(username: string): string {
  return `Hi ${assertSingleLine(username, "username")},`;
}

const SIGN_OFF = "— Deadwax";

/* ========================================================================== *
 * THE CATALOGUE
 * ========================================================================== */

/**
 * Confirming an address.
 *
 * The copy says the link is pressed and then confirmed, because that is what happens:
 * confirmation is a BUTTON PRESS on the landing page, never an effect of loading it (I-28).
 * Mail clients and security scanners follow links automatically, which would burn a single-use
 * token before the member ever clicked it.
 */
export function sendVerificationEmail(input: {
  to: string;
  username: string;
  url: string;
  ttlMinutes: number;
}): Promise<EmailResult> {
  const url = assertLink(input.url);
  return deliver({
    kind: "verification",
    to: input.to,
    subject: "Confirm your email for Deadwax",
    text: [
      greeting(input.username),
      "",
      "Open this link and press Confirm to finish setting up your account:",
      url,
      "",
      `The link works for ${input.ttlMinutes} minutes. If it has expired, ask for another from the banner at the top of any page.`,
      "",
      "If you did not create a Deadwax account, you can ignore this — nothing was set up in your name.",
      "",
      SIGN_OFF,
    ].join("\n"),
  });
}

/**
 * A reset the member asked for.
 *
 * The last paragraph matters: this mail is sent to an address that may not have an account,
 * and it is sent identically either way, because the request form answers identically either
 * way. Somebody who did not ask for it needs to be told that receiving it means nothing
 * happened.
 */
export function sendPasswordResetEmail(input: {
  to: string;
  username: string;
  url: string;
  ttlMinutes: number;
}): Promise<EmailResult> {
  const url = assertLink(input.url);
  return deliver({
    kind: "password-reset",
    to: input.to,
    subject: "Reset your Deadwax password",
    text: [
      greeting(input.username),
      "",
      "Open this link to choose a new password:",
      url,
      "",
      `The link works for ${input.ttlMinutes} minutes and can be used once. Your current password keeps working until you set a new one.`,
      "",
      "If you did not ask for this, nothing has changed and you do not need to do anything.",
      "",
      SIGN_OFF,
    ].join("\n"),
  });
}

/**
 * A reset an operator triggered from the admin panel.
 *
 * It is a separate message, not the same one with a different subject, because the member did
 * not ask for it and has to be told who did — an unexplained reset mail is indistinguishable
 * from a phishing attempt.
 *
 * THE ADMIN ACTION DOES NOT CHANGE THE PASSWORD; it sends this. So an admin cannot take over
 * an account without also holding the owner's mailbox, which is why there is no "set a new
 * password for this member" button anywhere in the panel.
 */
export function sendAdminPasswordResetEmail(input: {
  to: string;
  username: string;
  url: string;
  ttlMinutes: number;
}): Promise<EmailResult> {
  const url = assertLink(input.url);
  return deliver({
    kind: "admin-password-reset",
    to: input.to,
    subject: "A password reset was started for your Deadwax account",
    text: [
      greeting(input.username),
      "",
      "A Deadwax administrator started a password reset for your account, usually because you asked support for help getting back in.",
      "",
      "Open this link to choose a new password:",
      url,
      "",
      `The link works for ${input.ttlMinutes} minutes and can be used once. Your current password keeps working until you set a new one — nobody has changed it.`,
      "",
      "If this is a surprise, do not open the link, and reply to this message.",
      "",
      SIGN_OFF,
    ].join("\n"),
  });
}

import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";
import type { CSSProperties } from "react";

import { EMAIL_OTP_EXPIRY_SECONDS, formatEmailOtpExpiry } from "@/lib/auth/email-otp";
import { DASHBOARD_URL } from "@/lib/config";

/** 128px transparent crop of public/alfred.png, served with the deployed site. */
export const ALFRED_EMAIL_AVATAR_URL = `${DASHBOARD_URL}/email/alfred.png`;

export const OTP_EMAIL_SUBJECT = "Your Alfred sign-in code";

const fontFamily = '"Manrope", "Avenir Next", "Segoe UI", Helvetica, Arial, sans-serif';

/** Light-theme tokens from app/globals.css, written as hex because email clients ignore CSS variables. */
const color = {
  page: "#f8f7f3",
  paper: "#ffffff",
  ink: "#1b1b1d",
  muted: "#66666c",
  line: "#e6e2d8",
  gold: "#d9b45a",
  otp: "#f7f3ea",
  otpLine: "#e4dccb",
} as const;

const sheet: CSSProperties = {
  padding: "36px 24px 32px",
  fontFamily,
};

const wordmark: CSSProperties = {
  margin: 0,
  fontFamily,
  fontSize: "16px",
  lineHeight: "20px",
  fontWeight: 600,
  letterSpacing: "0.12em",
  color: color.ink,
};

const heading: CSSProperties = {
  margin: 0,
  fontFamily,
  fontSize: "26px",
  lineHeight: "32px",
  fontWeight: 600,
  color: color.ink,
};

const support: CSSProperties = {
  margin: "10px 0 0",
  fontFamily,
  fontSize: "16px",
  lineHeight: "24px",
  color: color.muted,
};

const otpCode: CSSProperties = {
  margin: 0,
  padding: "26px 8px 26px 14px",
  fontFamily,
  fontSize: "32px",
  lineHeight: "40px",
  fontWeight: 600,
  letterSpacing: "6px",
  textAlign: "center",
  color: color.ink,
  whiteSpace: "nowrap",
};

const expiry: CSSProperties = {
  margin: "18px 0 0",
  fontFamily,
  fontSize: "14px",
  lineHeight: "22px",
  textAlign: "center",
  color: color.ink,
};

const security: CSSProperties = {
  margin: "8px 0 0",
  fontFamily,
  fontSize: "14px",
  lineHeight: "22px",
  textAlign: "center",
  color: color.muted,
};

const footerMark: CSSProperties = {
  margin: 0,
  fontFamily,
  fontSize: "13px",
  lineHeight: "18px",
  fontWeight: 600,
  letterSpacing: "0.14em",
  color: color.ink,
};

export type OtpEmailProps = {
  code: string;
  expiryLabel: string;
};

export function otpPreviewText(expiryLabel: string): string {
  return `Enter it to get back in. It stays valid for ${expiryLabel}.`;
}

export function otpPlainText(code: string, expiryLabel: string): string {
  return [
    "Your Alfred sign-in code",
    "",
    "Here's the code you need to get back in.",
    "",
    code,
    "",
    `This code is valid for ${expiryLabel}.`,
    "",
    "If you didn't request this code, you can ignore this email. Don't share it with anyone.",
    "",
    "Alfred",
  ].join("\n");
}

export function OtpEmail({ code, expiryLabel }: OtpEmailProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <title>{OTP_EMAIL_SUBJECT}</title>
        <style>{`
          @media only screen and (max-width: 480px) {
            .alfred-sheet { padding: 32px 20px 28px !important; }
            .alfred-otp { font-size: 28px !important; line-height: 34px !important; letter-spacing: 4px !important; }
          }
        `}</style>
      </Head>
      <Body style={{ margin: 0, padding: "32px 12px", backgroundColor: color.page }}>
        <Preview>{otpPreviewText(expiryLabel)}</Preview>
        <Container style={{ maxWidth: "480px", width: "100%", margin: "0 auto" }}>
          <Section
            bgcolor={color.paper}
            style={{ backgroundColor: color.paper, border: `1px solid ${color.line}` }}
          >
            <Row>
              <Column className="alfred-sheet" style={sheet}>
                <Row>
                  <Column width="60" style={{ width: "60px", verticalAlign: "middle" }}>
                    <Img
                      src={ALFRED_EMAIL_AVATAR_URL}
                      width="48"
                      height="48"
                      alt="Alfred"
                      style={{ display: "block", width: "48px", height: "48px", border: 0 }}
                    />
                  </Column>
                  <Column style={{ verticalAlign: "middle" }}>
                    <Text style={wordmark}>Alfred</Text>
                  </Column>
                </Row>
                <Rule tone={color.gold} weight={2} before={22} after={28} />
                <Heading as="h1" m={0} style={heading}>
                  Your Alfred sign-in code
                </Heading>
                <Text style={support}>Here&apos;s the code you need to get back in.</Text>
                <OtpPanel code={code} />
                <Text style={expiry}>{`This code is valid for ${expiryLabel}.`}</Text>
                <Text style={security}>
                  If you didn&apos;t request this code, you can ignore this email. Don&apos;t share it with anyone.
                </Text>
                <Rule tone={color.line} weight={1} before={32} after={16} />
                <Text style={footerMark}>Alfred</Text>
              </Column>
            </Row>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

function Rule({ tone, weight, before, after }: { tone: string; weight: number; before: number; after: number }) {
  return (
    <table align="center" width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ width: "100%" }}>
      <tbody>
        <tr>
          <td height={before} style={{ height: `${before}px`, fontSize: "0", lineHeight: "0" }}>
            &nbsp;
          </td>
        </tr>
        <tr>
          <td style={{ padding: 0 }}>
            <table
              align="center"
              width="100%"
              border={0}
              cellPadding={0}
              cellSpacing={0}
              role="presentation"
              bgcolor={tone}
              style={{ width: "100%", backgroundColor: tone }}
            >
              <tbody>
                <tr>
                  <td height={weight} style={{ height: `${weight}px`, fontSize: "0", lineHeight: "0" }}>
                    &nbsp;
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
        <tr>
          <td height={after} style={{ height: `${after}px`, fontSize: "0", lineHeight: "0" }}>
            &nbsp;
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function OtpPanel({ code }: { code: string }) {
  return (
    <table
      align="center"
      width="100%"
      border={0}
      cellPadding={0}
      cellSpacing={0}
      role="presentation"
      style={{ width: "100%" }}
    >
      <tbody>
        <tr>
          <td height={28} style={{ height: "28px", fontSize: "0", lineHeight: "0" }}>
            &nbsp;
          </td>
        </tr>
        <tr>
          <td style={{ padding: 0 }}>
            <table
              align="center"
              width="100%"
              border={0}
              cellPadding={0}
              cellSpacing={0}
              role="presentation"
              bgcolor={color.gold}
              style={{ width: "100%", backgroundColor: color.gold }}
            >
              <tbody>
                <tr>
                  <td height={3} style={{ height: "3px", fontSize: "0", lineHeight: "0" }}>
                    &nbsp;
                  </td>
                </tr>
              </tbody>
            </table>
            <table
              align="center"
              width="100%"
              border={0}
              cellPadding={0}
              cellSpacing={0}
              role="presentation"
              bgcolor={color.otp}
              style={{
                width: "100%",
                backgroundColor: color.otp,
                borderRight: `1px solid ${color.otpLine}`,
                borderBottom: `1px solid ${color.otpLine}`,
                borderLeft: `1px solid ${color.otpLine}`,
              }}
            >
              <tbody>
                <tr>
                  <td align="center" style={{ backgroundColor: color.otp, textAlign: "center" }}>
                    <Text className="alfred-otp" style={otpCode}>
                      {code}
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** React 19 leaves hydration comments in static markup. Email clients do not need them. */
function emailHtml(html: string): string {
  return html.replace(/<!--(?!\[if)[\s\S]*?-->/g, "");
}

export async function buildOtpMessage(code: string): Promise<{ subject: string; text: string; html: string }> {
  const safeCode = code.replace(/[^\d]/g, "");
  const expiryLabel = formatEmailOtpExpiry(EMAIL_OTP_EXPIRY_SECONDS);
  const html = emailHtml(await render(<OtpEmail code={safeCode} expiryLabel={expiryLabel} />));
  return {
    subject: OTP_EMAIL_SUBJECT,
    text: otpPlainText(safeCode, expiryLabel),
    html,
  };
}

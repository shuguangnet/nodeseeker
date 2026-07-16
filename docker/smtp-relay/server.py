import json
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LISTEN_HOST = os.getenv("LISTEN_HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8080"))
RELAY_TOKEN = os.getenv("RELAY_TOKEN", "")

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "")
SMTP_SSL = os.getenv("SMTP_SSL", "false").lower() == "true"
SMTP_STARTTLS = os.getenv("SMTP_STARTTLS", "true").lower() == "true"


class RelayHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.write_json(200, {"ok": True})
            return

        self.write_json(404, {"ok": False, "message": "Not found"})

    def do_POST(self):
        if self.path != "/send-mail":
            self.write_json(404, {"ok": False, "message": "Not found"})
            return

        if RELAY_TOKEN:
            auth_header = self.headers.get("Authorization", "")
            if auth_header != f"Bearer {RELAY_TOKEN}":
                self.write_json(401, {"ok": False, "message": "Unauthorized"})
                return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            send_mail(payload)
            self.write_json(200, {"ok": True, "message": "Email sent"})
        except Exception as error:
            self.write_json(500, {"ok": False, "message": str(error)})

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args))

    def write_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def send_mail(payload):
    if not SMTP_HOST:
        raise ValueError("SMTP_HOST is required")

    mail_to = payload.get("to")
    mail_from = payload.get("from") or SMTP_FROM or SMTP_USERNAME
    subject = payload.get("subject") or "NodeSeek RSS Notification"
    text = payload.get("text") or ""
    html = payload.get("html") or ""

    if not mail_to:
        raise ValueError("Payload field 'to' is required")
    if not mail_from:
        raise ValueError("Payload field 'from' or SMTP_FROM is required")

    message = MIMEMultipart("alternative")
    message["Subject"] = subject
    message["From"] = mail_from
    message["To"] = mail_to

    if text:
        message.attach(MIMEText(text, "plain", "utf-8"))
    if html:
        message.attach(MIMEText(html, "html", "utf-8"))
    if not text and not html:
        message.attach(MIMEText("NodeSeek RSS notification", "plain", "utf-8"))

    smtp_class = smtplib.SMTP_SSL if SMTP_SSL else smtplib.SMTP
    with smtp_class(SMTP_HOST, SMTP_PORT, timeout=20) as smtp:
        if not SMTP_SSL and SMTP_STARTTLS:
            smtp.starttls()
        if SMTP_USERNAME or SMTP_PASSWORD:
            smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
        smtp.sendmail(mail_from, [mail_to], message.as_string())


def main():
    server = ThreadingHTTPServer((LISTEN_HOST, PORT), RelayHandler)
    print(f"SMTP relay listening on {LISTEN_HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()

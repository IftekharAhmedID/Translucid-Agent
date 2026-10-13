# TraceDog sender DNS

To send as reports@tracedog.co, add these records in Namecheap Advanced DNS.
Keep the website @ A and www CNAME records. Until verification, TraceDog can
send using the existing verified reports@translucid.cloud sender.

| Type | Host | Value | Priority |
| --- | --- | --- | --- |
| TXT | resend._domainkey | p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDhKr0DuaccWTv3fyS+ktiRhZ/XSNOEy1ksKwLp9V4mTQAwv94yXu0GzRUPQriGVN0anakai5P3WS5Lau66NGKmJtbCyQzkCN+QJqOI3+VfSNPI1EXfxcKOi/dsOJgAylCtIuMkPKJCzP2RpgvAqV7vrgHKDpkK4xfm7lEXApOy8QIDAQAB | — |
| MX | send | feedback-smtp.us-east-1.amazonses.com | 10 |
| TXT | send | v=spf1 include:amazonses.com ~all | — |
| CNAME | rsend | send.forge.rmta.net | — |

TTL: Automatic. Domain id: `f1e99eee-4caf-4600-a8b4-ce62a84930ec`. Trigger verification in Resend after adding the records.

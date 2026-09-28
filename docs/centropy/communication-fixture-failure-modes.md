# Governed communication certification fixture

Written before implementing the isolated fixture.

Failure modes: resolving a different Sarah; inventing a production address; choosing internal task creation instead of communication; losing the exact subject/body at approval; sending before approval; using a cross-tenant sender identity; bypassing the real credential resolver, ToolRegistry, delivery owner, Authority, or receipt; treating SMTP acceptance as recipient delivery; replaying a completed action and sending twice; losing the captured message; and enabling the fixture against a production database or a non-loopback SMTP host.

The fixture will create one explicitly authored test party with an `.invalid` address in a guarded localhost database. It will use the existing email transport injection seam to connect nodemailer to a real loopback SMTP capture server. The actual product intake, planner, action approval, ToolRegistry, credential resolution, canonical delivery, BusinessEffect, receipt, and browser are exercised. The capture records SMTP envelopes and accepted MIME bytes with hashes. This certifies the local governed communication path and SMTP acceptance; it does not claim delivery to a real Sarah or Gmail certification.

The fixture must fail closed unless its named disposable database and explicit flag match. No real mailbox, password, token, or contact is used. Canonical action replay must leave the accepted-message count unchanged.

Exact readback failure modes: wrong tenant or sender integration, missing OAuth read permission, ambiguous RFC Message-ID lookup, a draft instead of a sent message, changed recipient/subject/body, malformed or oversized MIME, unavailable provider, and confusing a sent-mail observation with recipient delivery. Production readback will use the authenticated Gmail API and match the approved content and frozen recipient. The SMTP fixture will independently read its captured bytes over loopback HTTP through an explicitly installed test adapter. It must never synthesize an observation from the action result or write a verification row directly. Both paths settle through the existing external observation owner.

References: [Gmail message get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), and [Message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).

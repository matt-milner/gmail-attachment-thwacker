# Gmail Attachment Manager

A Google Apps Script Gmail add-on that creates an attachment-reduced replacement message, verifies the replacement, and then moves **only the original message** to Gmail Trash.

The current script is designed as a cautious pilot. Test it first with disposable email and review the replacement in Gmail before using it on important correspondence.

## What it does

1. When you open a message and launch Attachment Manager, it asks Gmail for the message's parsed MIME metadata. It does **not** download the full raw message at this stage.
2. It lists attachments whose MIME parts explicitly have `Content-Disposition: attachment`, including filename and approximate size.
3. It provides **Select all attachments** and individual checkboxes. Checkbox changes use cached metadata where available rather than repeatedly downloading the message.
4. It checks Gmail's estimated total message size against the configured limit before raw-message processing begins.
5. Only after you click **Create replacement and move original to Trash** does it retrieve the full raw message, remove the selected MIME parts, and create a replacement in the original Gmail thread.
6. It retrieves the original and replacement again and verifies the replacement before moving the original message to Trash.
7. It checks that the original is in Trash and the replacement remains outside Trash in the expected thread.

The add-on does not send email to anyone. The replacement is inserted into your own Gmail mailbox.

## Important behavior and limitations

- **The original is moved to Trash only after verification succeeds.** The operation uses the Gmail message-level Trash API for the original message ID; it does not intentionally trash the entire conversation.
- Gmail may not refresh an already-open conversation immediately after the operation. Return to the inbox and reopen the conversation to see the replacement and updated message list.
- The replacement receives a new Gmail message ID and a new RFC `Message-ID`. It is not the original message modified in place.
- Conversation placement is checked by comparing Gmail thread IDs. If the replacement is not in the original thread, the script stops before moving the original to Trash.
- The original should remain recoverable in Gmail Trash under Gmail's normal retention behavior. Restore it from Trash if the replacement does not look right. Do not permanently empty Trash until you have checked the replacement.
- Only MIME parts explicitly marked `Content-Disposition: attachment` are offered for removal. Inline images or other embedded MIME parts may not appear in the selection list.
- The pilot rejects signed, encrypted, and certain special multipart message types. It also rejects messages whose MIME structure exceeds the configured depth or part-count safeguards, and messages without a safely identifiable plain-text or HTML body.
- The current whole-message limit is **32 MiB**. The metadata preflight uses Gmail's `sizeEstimate`, which is an estimate; the script also checks the actual raw-message byte count after retrieval. The early check is intended to stop clearly oversized messages before downloading the full raw content.
- The attachment sizes shown in the selection list are based on Gmail's parsed MIME part metadata and are approximate for display.
- CacheService is best-effort. Cached attachment metadata is retained for up to 10 minutes, but Google may evict it earlier. A cache miss triggers another lightweight metadata lookup.
- The script uses Apps Script CardService and the Advanced Gmail service. It is intended for a Gmail add-on test deployment, not as a standalone web app.

## Requirements

- A Google account with Gmail access.
- Permission to create and install a test Google Workspace add-on. A Google Workspace administrator may restrict add-on installation or OAuth scopes.
- Google Apps Script with the V8 runtime.
- The Advanced Gmail service (Gmail API v1) enabled in the Apps Script project.
- The OAuth scopes shown in the manifest below.

## Installation

### 1. Create an Apps Script project

1. Open [Google Apps Script](https://script.google.com/home/projects/create).
2. Create a new project and give it a name such as **Gmail Attachment Manager**.
3. In the left sidebar, open **Project Settings**.
4. Enable **Show `appsscript.json` manifest file in editor**.
5. Return to the editor using the `<>` icon.

### 2. Add the script

1. Open `Code.gs`.
2. Replace its contents with the complete latest `AttachmentManager.gs` source file supplied with this project.
3. Save the project.

You can keep the Apps Script filename `Code.gs`; the `.gs` filename does not have to match the source filename.

### 3. Configure the manifest

1. In the editor's Files list, open `appsscript.json`.
2. Replace its contents with the following manifest:

```json
{
  "timeZone": "America/Denver",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.addons.execute",
    "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
    "https://www.googleapis.com/auth/gmail.modify"
  ],
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Gmail",
        "serviceId": "gmail",
        "version": "v1"
      }
    ]
  },
  "addOns": {
    "common": {
      "name": "Attachment Manager",
      "logoUrl": "https://www.gstatic.com/images/icons/material/system/1x/attach_file_black_24dp.png",
      "homepageTrigger": {
        "runFunction": "amHome"
      }
    },
    "gmail": {
      "contextualTriggers": [
        {
          "unconditional": {},
          "onTriggerFunction": "amOnMessage"
        }
      ]
    }
  }
}
```

3. Save the manifest.

### 4. Confirm the Advanced Gmail service

The manifest declares the Advanced Gmail service. Also verify in the Apps Script editor:

1. Find **Services** in the left sidebar.
2. Click the `+` next to Services.
3. Select **Gmail API**, version **v1**, and click **Add** if it is not already listed.

If Apps Script asks you to configure a Google Cloud project or enable the Gmail API, follow the prompts and enable the Gmail API for the project used by this script.

### 5. Install a test deployment

1. Click **Deploy → Test deployments**.
2. Select the Google Workspace Add-on deployment type if prompted.
3. Install the test deployment.
4. Grant the requested Gmail permissions.
5. Open Gmail using the same Google account and refresh the page.
6. Open a message. Find **Attachment Manager** in Gmail's right-side add-on panel.

The test deployment uses the saved project code. After changing the script, save it and refresh Gmail. If the add-on continues to run stale code, revisit **Deploy → Test deployments** and update/reinstall the test deployment as needed.

## Using Attachment Manager

1. In Gmail, open the specific message that contains the attachment(s) you want to remove. The add-on operates on the currently opened individual message, not on every message in the conversation.
2. Open **Attachment Manager** from Gmail's right-side panel.
3. Review the sender, subject, estimated message size, total attachment size, and attachment list.
4. Select one or more attachments, or use **Select all attachments**. You can also deselect individual attachments after selecting all.
5. Click **Create replacement and move original to Trash**.
6. Wait for the add-on to report success or an error. Do not repeat the operation if it reports that a replacement may already exist; inspect the conversation first.
7. Reopen the Gmail conversation if necessary. Confirm that the replacement contains the expected message text and remaining attachments.
8. If anything is wrong, restore the original message from Gmail Trash. Do not permanently delete the original until the replacement has been checked.

## Configuration

The main limits are near the top of `AttachmentManager.gs`:

```javascript
const AM_MAX_RAW_BYTES = 32 * 1024 * 1024;
const AM_MAX_MIME_PARTS = 100;
const AM_MAX_DEPTH = 8;
const AM_PREFLIGHT_CACHE_SECONDS = 600;
```

- `AM_MAX_RAW_BYTES`: maximum estimated and then actual raw-message size accepted by the pilot. The current default is 32 MiB.
- `AM_MAX_MIME_PARTS`: maximum number of MIME parts the parser and metadata traversal will process.
- `AM_MAX_DEPTH`: maximum MIME nesting depth.
- `AM_PREFLIGHT_CACHE_SECONDS`: requested metadata cache lifetime in seconds (10 minutes). CacheService eviction can occur earlier.

Increasing the size limit does not guarantee that very large messages can be processed. Apps Script execution, memory, Gmail API, and service limits still apply. The script deliberately retains both the early estimate check and the later actual-byte check.

## Troubleshooting

### Attachment Manager does not appear in Gmail

- Confirm the test deployment was installed, not merely saved.
- Confirm you are signed into the same Google account used to install it.
- Refresh Gmail.
- Check whether your Workspace administrator restricts test add-ons.

### Missing `gmail.addons.execute` permission

Confirm that `appsscript.json` contains all three OAuth scopes listed above. Save the project, revisit the test deployment, reinstall/update it if required, and complete the authorization flow again.

### `Could not decode string`

The current source includes `amRawBytes()`, which accepts the byte-array representation used by the Advanced Gmail service as well as a Base64URL string. Make sure the entire latest source file was copied into the project and saved; do not retain an older duplicate function or old code file that is still part of the project.

### Message exceeds the size limit

The add-on checks `sizeEstimate` before raw-message retrieval and checks the actual byte count after retrieval. If the preflight size is above `AM_MAX_RAW_BYTES`, it stops before downloading the full message. Only change the configured limit if you are prepared to test the increased memory and execution requirements. A larger configured limit does not remove Apps Script service limits.

### Select All or individual checkbox changes are slow

The current version requests only parsed message metadata for the initial attachment list and caches that information for checkbox changes. It does not intentionally retrieve the full raw message until the create-and-trash action is clicked. CacheService may evict an entry early, which causes a lightweight metadata request to be repeated.

### The add-on stops safely during processing

Read the full error in the add-on and check **Apps Script → Executions** for the corresponding run and stack trace. If the error says a replacement may exist, use the Gmail ID in the message/log to inspect Gmail before retrying. The script intentionally avoids automatically retrying an uncertain insertion or deletion.

### Replacement appears in the same conversation but the conversation looks unchanged

Gmail may not refresh an already-open conversation immediately. Return to the inbox and reopen the conversation. Gmail can show a conversation-level attachment indicator even when the attachment belongs only to the original message now in Trash. Expand the messages and check the individual message's Trash status.

### Original or replacement is in Trash unexpectedly

The code targets the original message ID with the message-level Gmail Trash operation, not the thread ID. If the replacement appears in Trash too, do not permanently empty Trash. Restore the relevant message(s), inspect the individual message labels/status, and review the execution log before another attempt.

## Safety notes

- This tool replaces an email; Gmail does not support removing an attachment from an existing received message in place.
- The replacement has a new Gmail message ID and RFC `Message-ID`.
- The original message is moved to Trash only after the replacement has been inserted and verified.
- If an insertion succeeds but a later step fails, a replacement may exist even though the add-on reports an error. Inspect Gmail before retrying.
- If the Trash request is issued but a subsequent verification fails, the original may already be in Trash. Check Gmail Trash before retrying.
- Do not use the pilot on encrypted, signed, legally significant, or irreplaceable correspondence until you have tested the exact message type and are comfortable with the result.

## Current source behavior

This README describes the `AttachmentManager.gs` revision that uses Gmail parsed metadata for preflight and selection, a 32 MiB raw-message limit, a 10-minute best-effort metadata cache, replacement MIME validation, and message-level trashing of the original.

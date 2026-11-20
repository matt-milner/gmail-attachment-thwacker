/**
 * Gmail Attachment Manager - one-action replace-and-trash add-on.
 *
 * Creates and verifies an attachment-reduced COPY, then moves ONLY the
 * original message to Trash if every safeguard passes.
 * Test on disposable messages before using on correspondence you value.
 * Requires the Advanced Gmail API (Gmail v1) and gmail.modify scope.
 */

const AM_MAX_RAW_BYTES = 32 * 1024 * 1024;
const AM_MAX_MIME_PARTS = 100;
const AM_MAX_DEPTH = 8;
// Cache lightweight attachment metadata for up to 10 minutes.
const AM_PREFLIGHT_CACHE_SECONDS = 600;

function amHome() {
  const section = CardService.newCardSection().addWidget(
    CardService.newTextParagraph().setText(
      'Open a Gmail message, then select Attachment Manager in the sidebar. ' +
      'This tool creates a verified replacement without selected attachments, ' +
      'then moves only the original message to Trash if every check succeeds.'
    )
  );
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Attachment Manager'))
    .addSection(section).build();
}

function amOnMessage(e) {
  try {
    const id = amCurrentMessageId(e);
    // Initial view uses Gmail's parsed metadata only. It does NOT fetch raw MIME.
    const info = amGetPreflightInfo(id, true);
    return amBuildMessageCard(id, [], info);
  } catch (err) {
    return amErrorCard(err);
  }
}


/** Build or rebuild the attachment-selection card from lightweight metadata. */
function amBuildMessageCard(id, selectedPaths, info) {
  info = info || amGetPreflightInfo(id, false);

  const files = info.attachments || [];
  const validPaths = new Set(files.map(file => file.path));
  const selected = new Set(
    (selectedPaths || []).filter(path => validPaths.has(path))
  );
  const attachmentTotal = files.reduce(
    (sum, file) => sum + (Number(file.approxBytes) || 0), 0
  );

  const section = CardService.newCardSection()
    .addWidget(amText(
      'From',
      amApiHeader(info.headers, 'From') || '(unknown)'
    ))
    .addWidget(amText(
      'Subject',
      amApiHeader(info.headers, 'Subject') || '(none)'
    ))
    .addWidget(amText('Message size', amSize(info.sizeEstimate)))
    .addWidget(amText('Total attachment size', amSize(attachmentTotal)))
    .addWidget(amText('Original Gmail ID', id));

  if (!files.length) {
    section.addWidget(CardService.newTextParagraph().setText(
      'No removable MIME attachments were detected. The pilot only offers ' +
      'parts explicitly marked Content-Disposition: attachment.'
    ));
  } else {
    const selectAll = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('selectAll')
      .setTitle('Bulk selection')
      .addItem(
        'Select all attachments',
        'ALL',
        selected.size === files.length
      )
      .setOnChangeAction(
        CardService.newAction()
          .setFunctionName('amSelectAllChanged')
          .setParameters({messageId: id})
      );
    section.addWidget(selectAll);

    const checks = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('attachments')
      .setTitle('Select attachments to remove')
      .setOnChangeAction(
        CardService.newAction()
          .setFunctionName('amAttachmentsChanged')
          .setParameters({messageId: id})
      );

    files.forEach(file => checks.addItem(
      amClean(file.name, 80) + ' (' + amSize(file.approxBytes) + ')',
      file.path,
      selected.has(file.path)
    ));
    section.addWidget(checks);

    section.addWidget(CardService.newTextParagraph().setText(
      '<b>What happens next:</b> The attachment list and size checks use ' +
      'message metadata only. The complete original email is downloaded ' +
      'only after you click the button. Attachment Manager then creates a ' +
      'replacement, verifies it, and moves only the original message to Trash.'
    ));
    section.addWidget(CardService.newTextParagraph().setText(
      '<b>After completion:</b> Gmail may not refresh the open conversation ' +
      'immediately. You may need to return to the inbox and reopen the ' +
      'conversation to see the replacement. The original will be in Trash ' +
      'so you can restore it if anything looks wrong.'
    ));
    section.addWidget(amButton(
      'Create replacement and move original to Trash',
      'amCreateCopy',
      {messageId: id}
    ));
  }

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Attachment Manager')
      .setSubtitle(files.length + ' removable attachment(s)'))
    .addSection(section).build();
}


/** Select or clear all attachments without fetching raw message content. */
function amSelectAllChanged(e) {
  try {
    const id = amParam(e, 'messageId');
    const input = e && e.commonEventObject &&
      e.commonEventObject.formInputs &&
      e.commonEventObject.formInputs.selectAll;
    const values = input && input.stringInputs
      ? input.stringInputs.value || [] : [];

    const info = amGetPreflightInfo(id, false);
    const selectedPaths = values.includes('ALL')
      ? info.attachments.map(file => file.path)
      : [];

    return amUpdate(amBuildMessageCard(id, selectedPaths, info));
  } catch (err) {
    return amUpdate(amErrorCard(err));
  }
}


/** Rebuild the card after individual checkbox changes using cached metadata. */
function amAttachmentsChanged(e) {
  try {
    const id = amParam(e, 'messageId');
    const input = e && e.commonEventObject &&
      e.commonEventObject.formInputs &&
      e.commonEventObject.formInputs.attachments;
    const selectedPaths = input && input.stringInputs
      ? input.stringInputs.value || [] : [];

    const info = amGetPreflightInfo(id, false);
    return amUpdate(amBuildMessageCard(id, selectedPaths, info));
  } catch (err) {
    return amUpdate(amErrorCard(err));
  }
}

function amCreateCopy(e) {
  let insertedId = '';
  let trashCallStarted = false;
  let originalId = '';
  const lock = LockService.getUserLock();

  try {
    if (!lock.tryLock(30000)) {
      throw new Error('Another Attachment Manager operation is running. Please wait and try again.');
    }

    originalId = amParam(e, 'messageId');

    // Refresh lightweight metadata and reject oversized messages BEFORE
    // downloading the full raw email. This also validates that selected paths
    // still refer to current attachment parts.
    const preflight = amGetPreflightInfo(originalId, true);
    if ((preflight.labelIds || []).includes('TRASH')) {
      throw new Error('This original message is already in Trash. No new replacement was created.');
    }

    const selected = amSelections(e);
    const metadataChosen = amValidateSelections(
      preflight.attachments, selected
    );
    const selectedAttachmentBytes = metadataChosen.reduce(
      (sum, file) => sum + (Number(file.approxBytes) || 0), 0
    );
    if (selectedAttachmentBytes > AM_MAX_RAW_BYTES) {
      throw new Error(
        'The selected attachments exceed the Attachment Manager size limit (' +
        amSize(selectedAttachmentBytes) + '). Maximum: ' +
        amSize(AM_MAX_RAW_BYTES) + '. No changes were made.'
      );
    }

    // Heavy processing starts only after the preflight checks pass.
    const source = amGetSource(originalId);
    if ((source.message.labelIds || []).includes('TRASH')) {
      throw new Error('This original message is already in Trash. No new replacement was created.');
    }
    const chosen = amValidateSelections(
      amAttachmentParts(source.mime), selected
    );
    const reduced = amStripMime(
      source.mime, new Set(chosen.map(p => p.path))
    );
    amValidateReduced(source.mime, reduced, chosen);

    // Create a distinct RFC Message-ID. Invalid transport authentication
    // headers from the original are removed by amReplacementHeaders().
    const newRfcId = 'attachment-manager-' + Utilities.getUuid() + '@local.invalid';
    reduced.headers = amReplacementHeaders(
      reduced.headers,
      newRfcId,
      originalId,
      amHeader(source.mime.headers, 'Message-ID')
    );

    const mimeText = amRender(reduced);
    const bytes = amLatin1ToBytes(mimeText);
    if (bytes.length >= source.rawBytes.length) {
      throw new Error('The replacement is not smaller than the original; aborted.');
    }

    const request = {
      raw: Utilities.base64EncodeWebSafe(bytes),
      threadId: source.message.threadId,
      labelIds: amSafeLabels(source.message.labelIds || [])
    };

    const inserted = Gmail.Users.Messages.insert(
      request,
      'me',
      null,
      {internalDateSource: 'dateHeader'}
    );

    if (inserted && inserted.id) insertedId = inserted.id;
    if (!insertedId || insertedId === originalId) {
      throw new Error(
        'Gmail did not return a distinct replacement ID. Check Gmail before retrying; a copy may have been created.'
      );
    }

    // Re-fetch both messages from Gmail and verify the replacement byte-for-byte
    // (apart from intentionally changed top-level transport headers) before Trash.
    const pair = amValidateReplacementPair(
      originalId,
      insertedId,
      selected
    );

    // Final precondition check: original must still be present and not trashed.
    if ((pair.original.message.labelIds || []).includes('TRASH')) {
      throw new Error('The original is already in Trash. No further action was taken.');
    }
    if ((pair.copy.message.labelIds || []).includes('TRASH')) {
      throw new Error('The replacement is in Trash. The original was not moved.');
    }

    // This is the one intentional destructive action. Gmail's message-level
    // operation targets only originalId, never the conversation/thread.
    trashCallStarted = true;
    Gmail.Users.Messages.trash('me', originalId);

    // Verify both outcomes. If a read fails after Trash, explain that the
    // operation may already have succeeded and tell the user to check Trash.
    const trashedOriginal = Gmail.Users.Messages.get(
      'me', originalId, {format: 'metadata'}
    );
    if (!trashedOriginal || !(trashedOriginal.labelIds || []).includes('TRASH')) {
      throw new Error(
        'Gmail accepted the Trash request, but the follow-up check did not confirm the original in Trash.'
      );
    }

    const keptCopy = Gmail.Users.Messages.get(
      'me', insertedId, {format: 'metadata'}
    );
    if (!keptCopy || (keptCopy.labelIds || []).includes('TRASH') ||
        keptCopy.threadId !== pair.original.message.threadId) {
      throw new Error(
        'The original is in Trash, but the replacement could not be confirmed in the expected conversation.'
      );
    }

    console.log(JSON.stringify({
      action: 'replacement_created_and_original_trashed',
      originalId: originalId,
      replacementId: insertedId,
      threadId: pair.original.message.threadId,
      removedCount: pair.chosen.length,
      remainingCount: pair.remaining.length
    }));

    const section = CardService.newCardSection()
      .addWidget(amText('Subject', amHeader(pair.copy.mime.headers, 'Subject') || '(no subject)'))
      .addWidget(amText('Attachments removed', String(pair.chosen.length)))
      .addWidget(amText('Attachments remaining', String(pair.remaining.length)))
      .addWidget(amText('Replacement Gmail ID', insertedId))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Completed:</b> Gmail accepted the attachment-free replacement, ' +
        'the replacement passed verification, and only the original message ' +
        'was moved to Trash. Other messages in the conversation were not targeted.'
      ))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Please check the conversation.</b> Gmail may not refresh the open ' +
        'conversation immediately. Return to the inbox and reopen the conversation ' +
        'if you do not see the replacement. Confirm its text and remaining attachments.'
      ))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Recovery:</b> The original message is in Gmail Trash. If the replacement ' +
        'does not look right, open Trash, find the original message, and choose ' +
        'Move to Inbox (or restore it to its previous location) before making any ' +
        'other changes. Gmail normally retains trashed messages for 30 days.'
      ));

    return amUpdate(CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle('Replacement created; original moved to Trash'))
      .addSection(section).build());

  } catch (err) {
    const detail = insertedId
      ? ' A replacement may exist (Gmail ID: ' + insertedId + '). Check the conversation before retrying.'
      : '';
    const safetyMessage = trashCallStarted
      ? ' The Trash request may have succeeded. Check Gmail Trash for the original before retrying. The replacement was not targeted.'
      : ' The original was not intentionally moved to Trash. ' +
        (insertedId ? 'A replacement may exist; inspect Gmail before retrying.' : 'No replacement ID was returned.');
    console.error(
      'Attachment Manager operation failed: ' + (err.stack || err) + detail
    );
    return amUpdate(amErrorCard(
      new Error(String(err.message || err) + detail),
      safetyMessage
    ));
  } finally {
    try {
      if (lock.hasLock()) lock.releaseLock();
    } catch (ignored) {
      console.error('Could not release operation lock: ' + ignored);
    }
  }
}

// ----- Replacement verification safeguards -----

function amValidateReplacementPair(originalId, replacementId, selectedPaths) {
  if (!originalId || !replacementId || originalId === replacementId) {
    throw new Error('Original and replacement IDs must be distinct valid messages.');
  }

  const original = amGetSource(originalId);
  const copy = amGetSource(replacementId);

  if ((original.message.labelIds || []).includes('TRASH')) {
    throw new Error('The original is already in Trash. No further action was taken.');
  }
  if ((copy.message.labelIds || []).includes('TRASH')) {
    throw new Error('The replacement is already in Trash. No further action was taken.');
  }
  if (!original.message.threadId ||
      original.message.threadId !== copy.message.threadId) {
    throw new Error(
      'The replacement is no longer in the original Gmail conversation. ' +
      'Automatic removal is disabled; keep the original.'
    );
  }

  const chosen = amValidateSelections(
    amAttachmentParts(original.mime), selectedPaths
  );
  const expectedMime = amStripMime(
    original.mime, new Set(chosen.map(part => part.path))
  );
  amValidateReduced(original.mime, expectedMime, chosen);

  // Verify that every MIME leaf remaining after the requested removals is
  // byte-for-byte equivalent to the corresponding leaf in the replacement.
  const expectedLeaves = amAllLeaves(expectedMime).map(amLeafWireValue);
  const actualLeaves = amAllLeaves(copy.mime).map(amLeafWireValue);
  if (JSON.stringify(expectedLeaves) !== JSON.stringify(actualLeaves)) {
    throw new Error(
      'The replacement MIME content no longer exactly matches the expected ' +
      'message with only the selected attachments removed. Keep the original.'
    );
  }

  // Confirm important visible and threading headers were preserved.
  const headersToCompare = [
    'From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Subject', 'Date',
    'In-Reply-To', 'References'
  ];
  headersToCompare.forEach(name => {
    const before = amNormalizeHeader(amHeader(original.mime.headers, name));
    const after = amNormalizeHeader(amHeader(copy.mime.headers, name));
    if (before !== after) {
      throw new Error(
        'Replacement verification failed: the ' + name +
        ' header differs. Keep the original.'
      );
    }
  });

  return {
    original: original,
    copy: copy,
    chosen: chosen,
    remaining: amAttachmentParts(copy.mime)
  };
}

function amLeafWireValue(part) {
  return part.headers + part.sep + part.body;
}

function amNormalizeHeader(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// ----- Gmail data / safeguards -----

function amCurrentMessageId(e) {
  const id = e && e.gmail && e.gmail.messageId;
  if (!id) throw new Error('Open a specific Gmail message and launch the add-on.');
  return id;
}
function amParam(e, key) {
  const value = e && e.commonEventObject && e.commonEventObject.parameters &&
    e.commonEventObject.parameters[key];
  if (!value) throw new Error('Missing action parameter: ' + key);
  return String(value);
}
function amSelections(e) {
  const input = e && e.commonEventObject && e.commonEventObject.formInputs &&
    e.commonEventObject.formInputs.attachments;
  return (input && input.stringInputs && input.stringInputs.value) || [];
}
/**
 * Build a Gmail partial-response field mask for the parsed MIME tree.
 * The mask deliberately omits body.data, so attachment/message contents
 * are not downloaded during the selection phase.
 */
function amPreflightFieldMask(depth) {
  const fields = 'mimeType,filename,headers,body(size,attachmentId)';
  if (depth <= 0) return fields;
  return fields + ',parts(' + amPreflightFieldMask(depth - 1) + ')';
}


/**
 * Return lightweight message and attachment metadata.
 * Cache is best-effort: Apps Script may evict entries before expiration.
 */
function amGetPreflightInfo(messageId, forceRefresh) {
  const cache = CacheService.getUserCache();
  const cacheKey = 'am_preflight_' + messageId;

  if (!forceRefresh) {
    let cached = null;
    try {
      cached = cache.get(cacheKey);
    } catch (err) {
      console.warn('Preflight cache read skipped: ' + err);
    }
    if (cached) {
      let cachedInfo = null;
      try {
        cachedInfo = JSON.parse(cached);
      } catch (err) {
        console.warn('Cached preflight metadata was unreadable: ' + err);
      }
      if (cachedInfo) {
        // Do not swallow a size-limit error as though it were a cache error.
        amCheckPreflightSize(cachedInfo);
        return cachedInfo;
      }
    }
  }

  const message = Gmail.Users.Messages.get('me', messageId, {
    format: 'full',
    fields: 'id,threadId,sizeEstimate,labelIds,payload(' +
      amPreflightFieldMask(AM_MAX_DEPTH) + ')'
  });

  if (!message || !message.payload) {
    throw new Error('Gmail did not return the message metadata.');
  }

  const info = {
    messageId: message.id,
    threadId: message.threadId,
    sizeEstimate: Number(message.sizeEstimate),
    labelIds: message.labelIds || [],
    headers: message.payload.headers || [],
    attachments: amCollectPreflightAttachments(message.payload)
  };

  // Reject oversized messages before any raw-message retrieval.
  amCheckPreflightSize(info);

  try {
    const serialized = JSON.stringify(info);
    // CacheService has a 100 KB per-item limit. A cache miss is safe;
    // it simply causes the next checkbox event to repeat this light lookup.
    if (serialized.length <= 95000) {
      cache.put(cacheKey, serialized, AM_PREFLIGHT_CACHE_SECONDS);
    }
  } catch (err) {
    console.warn('Preflight metadata was not cached: ' + err);
  }

  return info;
}


/** Extract attachment list and Gmail MIME paths from parsed metadata. */
function amCollectPreflightAttachments(payload) {
  const attachments = [];
  let partCount = 0;

  function visit(part, path, depth) {
    if (depth > AM_MAX_DEPTH || ++partCount > AM_MAX_MIME_PARTS) {
      throw new Error('MIME structure exceeds the pilot safety limits.');
    }

    const headers = part.headers || [];
    const dispositionHeader = headers.find(
      h => String(h.name || '').toLowerCase() === 'content-disposition'
    );
    const typeHeader = headers.find(
      h => String(h.name || '').toLowerCase() === 'content-type'
    );
    const disposition = dispositionHeader ? dispositionHeader.value : '';
    const contentType = typeHeader ? typeHeader.value : (part.mimeType || '');

    // Match the raw MIME parser: only explicit attachment dispositions
    // are offered for removal. Inline images are not selected implicitly.
    if (/^attachment\b/i.test(disposition)) {
      const filename = part.filename ||
        amMimeParameter(disposition, 'filename') ||
        amMimeParameter(contentType, 'name') ||
        '(unnamed attachment)';
      const bodySize = Number(part.body && part.body.size || 0);

      attachments.push({
        path: path,
        name: filename,
        approxBytes: Number.isFinite(bodySize) ? bodySize : 0,
        mimeType: part.mimeType || ''
      });
    }

    (part.parts || []).forEach((child, index) => {
      visit(child, path + '.' + index, depth + 1);
    });
  }

  visit(payload, '0', 0);
  return attachments;
}


/**
 * Reject messages whose estimated total size is above the tool limit.
 * Also report the aggregate attachment size before any raw MIME work.
 */
function amCheckPreflightSize(info) {
  const size = Number(info.sizeEstimate);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
      'Gmail did not provide a valid message-size estimate. ' +
      'No message content was downloaded and no changes were made.'
    );
  }

  const attachmentTotal = (info.attachments || []).reduce(
    (sum, file) => sum + (Number(file.approxBytes) || 0), 0
  );

  if (size > AM_MAX_RAW_BYTES) {
    throw new Error(
      'This message is too large for Attachment Manager (' +
      amSize(size) + '). Maximum: ' + amSize(AM_MAX_RAW_BYTES) +
      '. The size was checked before downloading the original message. ' +
      'No changes were made.'
    );
  }

  if (attachmentTotal > AM_MAX_RAW_BYTES) {
    throw new Error(
      'The attachments alone exceed the Attachment Manager size limit (' +
      amSize(attachmentTotal) + '). Maximum: ' + amSize(AM_MAX_RAW_BYTES) +
      '. No changes were made.'
    );
  }
}


/** Read a standard header from Gmail API's header array. */
function amApiHeader(headers, name) {
  const match = (headers || []).find(
    h => String(h.name || '').toLowerCase() === name.toLowerCase()
  );
  return match ? match.value : '';
}


function amGetSource(id) {
  const message = Gmail.Users.Messages.get('me', id, {format: 'raw'});
  if (!message || !message.raw) throw new Error('Cannot read original Gmail message.');
  if ((message.sizeEstimate || 0) > AM_MAX_RAW_BYTES) {
    throw new Error('This message is too large for the pilot (' +
      amSize(message.sizeEstimate) + '). Max: ' + amSize(AM_MAX_RAW_BYTES) + '.');
  }
  const rawBytes = amRawBytes(message.raw);
  if (rawBytes.length > AM_MAX_RAW_BYTES) {
    throw new Error('Raw email exceeds the ' + amSize(AM_MAX_RAW_BYTES) + ' pilot limit.');
  }
  const mime = amParseMime(amBytesToLatin1(rawBytes));
  if (!amTextParts(mime).length) {
    throw new Error('This message has no safely identifiable text/plain or text/html body.');
  }
  return {message: message, rawBytes: rawBytes, mime: mime};
}
function amSafeLabels(labels) {
  return labels.filter(id => id.indexOf('Label_') === 0 ||
    ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT'].indexOf(id) >= 0);
}
function amValidateSelections(files, selections) {
  if (!Array.isArray(selections) || !selections.length) {
    throw new Error('Select at least one removable attachment.');
  }
  const valid = new Map(files.map(p => [p.path, p]));
  if (new Set(selections).size !== selections.length) {
    throw new Error('Duplicate attachment selection.');
  }
  return selections.map(path => {
    if (!valid.has(path)) throw new Error('Unknown or unsafe attachment path: ' + path);
    return valid.get(path);
  });
}
function amValidateReduced(original, reduced, chosen) {
  const beforeText = amTextParts(original).map(p => p.body).join('\u0000');
  const afterText = amTextParts(reduced).map(p => p.body).join('\u0000');
  if (!afterText || beforeText !== afterText) {
    throw new Error('Message text changed unexpectedly. Refusing to create a copy.');
  }
  const expected = amAttachmentParts(original).length - chosen.length;
  if (amAttachmentParts(reduced).length !== expected) {
    throw new Error('Attachment removal validation failed.');
  }
}

// ----- Conservative MIME parser / byte-exact reconstruction -----
// MIME bodies stay in a Latin-1 byte-preserving representation; we do NOT
// decode and re-encode text or binary parts. Only selected leaf parts are cut.

function amBytesToLatin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    const chunk = bytes.slice(i, i + 4096).map(b => b & 255);
    out += String.fromCharCode.apply(null, chunk);
  }
  return out;
}
function amLatin1ToBytes(str) {
  const out = new Array(str.length);
  for (let i = 0; i < str.length; ++i) {
    const c = str.charCodeAt(i);
    if (c > 255) throw new Error('Unexpected non-byte character in MIME.');
    out[i] = c > 127 ? c - 256 : c;
  }
  return out;
}
function amParseMime(raw) {
  const count = {n: 0};
  function parse(entity, path, depth) {
    if (depth > AM_MAX_DEPTH || ++count.n > AM_MAX_MIME_PARTS) {
      throw new Error('MIME nesting or part count exceeds pilot safety limits.');
    }
    const split = /\r\n\r\n|\n\n/.exec(entity);
    if (!split) throw new Error('Unrecognized MIME entity with no header separator.');
    const headers = entity.slice(0, split.index);
    const sep = split[0];
    const body = entity.slice(split.index + sep.length);
    const type = amHeader(headers, 'Content-Type') || 'text/plain';
    const typeLower = type.toLowerCase();
    if (/^multipart\/(signed|encrypted|report|digest)\b/.test(typeLower) ||
        /(?:pkcs7|pgp-encrypted|pgp-signature)/.test(typeLower)) {
      throw new Error('Signed, encrypted, or special multipart email is not supported.');
    }
    if (/^multipart\//.test(typeLower)) {
      const boundary = amMimeParameter(type, 'boundary');
      if (!boundary || /[\r\n]/.test(boundary)) {
        throw new Error('Missing or unsafe multipart boundary.');
      }
      const pattern = new RegExp('^--' + amRegexEscape(boundary) +
        '(--)?[ \\t]*(?:\\r?\\n|$)', 'gm');
      const marks = [];
      let hit;
      while ((hit = pattern.exec(body)) !== null) {
        marks.push({start: hit.index, end: pattern.lastIndex,
          close: !!hit[1], delimiter: hit[0]});
        if (marks.length > AM_MAX_MIME_PARTS + 2) {
          throw new Error('Too many MIME boundaries.');
        }
      }
      if (marks.length < 2 || marks[0].close || !marks[marks.length - 1].close) {
        throw new Error('Malformed or incomplete multipart boundaries.');
      }
      const parts = [];
      for (let i = 0; i < marks.length - 1; i++) {
        if (marks[i].close) throw new Error('Unexpected early MIME closing boundary.');
        const childText = body.slice(marks[i].end, marks[i + 1].start);
        parts.push({delimiter: marks[i].delimiter,
          node: parse(childText, path + '.' + i, depth + 1)});
      }
      return {headers: headers, sep: sep, path: path, multipart: true,
        preamble: body.slice(0, marks[0].start), parts: parts,
        closing: marks[marks.length - 1].delimiter,
        epilogue: body.slice(marks[marks.length - 1].end)};
    }
    const disposition = amHeader(headers, 'Content-Disposition');
    const attachment = /^attachment\b/i.test(disposition);
    const name = amMimeParameter(disposition, 'filename') ||
      amMimeParameter(type, 'name') || '(unnamed attachment)';
    return {headers: headers, sep: sep, path: path, multipart: false,
      body: body, type: typeLower, attachment: attachment,
      name: name, approxBytes: Math.round(body.length * 0.75)};
  }
  return parse(raw, '0', 0);
}
function amHeader(headers, field) {
  const blocks = headers.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  const prefix = field.toLowerCase() + ':';
  const line = blocks.find(s => s.toLowerCase().startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}
function amMimeParameter(header, key) {
  const re = new RegExp('(?:^|;)\\s*' + key +
    '=(?:"((?:\\\\.|[^"])*)"|([^;\\s]*))', 'i');
  const hit = re.exec(header || '');
  return hit ? (hit[1] || hit[2] || '').replace(/\\(["\\])/g, '$1') : '';
}
function amRegexEscape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function amAllLeaves(node) {
  return node.multipart ? node.parts.flatMap(p => amAllLeaves(p.node)) : [node];
}
function amAttachmentParts(node) {
  return amAllLeaves(node).filter(p => p.attachment);
}
function amTextParts(node) {
  return amAllLeaves(node).filter(p => !p.attachment &&
    /^text\/(?:plain|html)\b/.test(p.type));
}
function amStripMime(node, paths) {
  if (!node.multipart) return paths.has(node.path) ? null : Object.assign({}, node);
  const parts = node.parts.map(part => ({
    delimiter: part.delimiter, node: amStripMime(part.node, paths)
  })).filter(p => p.node !== null);
  if (!parts.length) throw new Error('Cannot remove every part of a multipart entity.');
  return Object.assign({}, node, {parts: parts});
}
function amRender(node) {
  if (!node.multipart) return node.headers + node.sep + node.body;
  return node.headers + node.sep + node.preamble +
    node.parts.map(p => p.delimiter + amRender(p.node)).join('') +
    node.closing + node.epilogue;
}
function amReplacementHeaders(headers, newRfcId, gmailId, oldRfcId) {
  const lines = headers.split(/\r?\n/);
  const fields = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1].push(line);
    else fields.push([line]);
  }
  const removed = /^(?:message-id|dkim-signature|domainkey-signature|authentication-results|arc-[a-z-]+|content-length|content-md5):/i;
  const kept = fields.filter(group => !removed.test(group[0])).map(group => group.join('\r\n'));
  kept.push('Message-ID: <' + newRfcId + '>');
  kept.push('X-Attachment-Manager-Source-Gmail-ID: ' + gmailId);
  if (oldRfcId) kept.push('X-Attachment-Manager-Original-Message-ID: ' +
    oldRfcId.replace(/[\r\n]/g, ' '));
  return kept.join('\r\n');
}

// ----- Card helpers -----
function amText(label, content) {
  return CardService.newTextParagraph().setText(
    '<b>' + amEscape(label) + ':</b> ' + amEscape(amClean(content, 240))
  );
}
function amButton(text, callback, params) {
  const action = CardService.newAction().setFunctionName(callback).setParameters(params);
  return CardService.newTextButton().setText(text).setOnClickAction(action);
}
function amPush(card) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card)).build();
}
function amUpdate(card) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card)).build();
}
function amErrorCard(err, safetyMessage) {
  console.error('Attachment Manager: ' + (err.stack || err));
  const assurance = safetyMessage ||
    'No original messages were deleted or moved to Trash.';
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Attachment Manager - stopped safely'))
    .addSection(CardService.newCardSection().addWidget(
      CardService.newTextParagraph().setText(amEscape(String(err.message || err)) +
        '<br><b>' + amEscape(assurance) + '</b>')
    )).build();
}
function amClean(value, limit) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, limit);
}
function amEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function amSize(n) { return (n / 1024 / 1024).toFixed(2) + ' MiB approx.'; }


/**
 * Normalize Gmail raw data whether supplied as an Apps Script byte array
 * or as the Base64URL string representation used by the Gmail REST API.
 */
function amRawBytes(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    return Utilities.base64DecodeWebSafe(raw);
  }
  throw new Error('Unexpected Gmail raw message data type: ' + typeof raw);
}

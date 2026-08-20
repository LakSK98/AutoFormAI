import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import type { FormField } from '@/lib/formFields';
import { submitResponse } from '@/lib/googleFormSubmit';

/**
 * Called by QStash (or directly, for the "test one response" path).
 *
 * If the QStash signing keys are configured the request signature is verified,
 * so the endpoint cannot be used by anyone else to push submissions through
 * this deployment.
 */
async function verifySignature(req: Request, rawBody: string): Promise<string | null> {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey || !nextSigningKey) {
    console.warn(
      '[submit] QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY are not set — request signatures are NOT being verified.',
    );
    return null;
  }

  const signature = req.headers.get('upstash-signature');
  if (!signature) return 'Missing Upstash-Signature header.';

  try {
    const receiver = new Receiver({ currentSigningKey, nextSigningKey });
    const valid = await receiver.verify({ signature, body: rawBody });
    return valid ? null : 'Invalid QStash signature.';
  } catch (err) {
    return `Signature verification failed: ${(err as Error).message}`;
  }
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();

    // Every request to this endpoint arrives from QStash. The in-app "test one
    // response" path calls submitResponse() in-process and never comes through
    // here, so there is no reason to offer a header-based bypass.
    const sigError = await verifySignature(req, rawBody);
    if (sigError) {
      return NextResponse.json({ error: sigError }, { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Request body was not valid JSON.' }, { status: 400 });
    }

    const { formUrl, data, fields, pageCount } = body ?? {};

    if (!formUrl || typeof formUrl !== 'string') {
      return NextResponse.json({ error: 'Missing formUrl.' }, { status: 400 });
    }
    if (!data || typeof data !== 'object') {
      return NextResponse.json({ error: 'Missing data.' }, { status: 400 });
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      return NextResponse.json({ error: 'Missing field schema.' }, { status: 400 });
    }

    const seen = new Set<string>();
    const dedupedFields = (fields as FormField[]).filter((f) => {
      if (!f?.name || seen.has(f.name)) return false;
      seen.add(f.name);
      return true;
    });

    const result = await submitResponse({
      formUrl,
      fields: dedupedFields,
      data: data as Record<string, unknown>,
      pageCount: typeof pageCount === 'number' ? pageCount : undefined,
    });

    for (const w of result.warnings) console.warn(`[submit] ${w}`);

    if (!result.success) {
      console.error('[submit] failed:', result.error, JSON.stringify(result.pages));
      // 500 makes QStash retry, which is what we want for transient failures.
      return NextResponse.json(
        { error: result.error, pages: result.pages, warnings: result.warnings },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Response recorded.',
      pages: result.pages,
      warnings: result.warnings,
    });
  } catch (error) {
    console.error('Error submitting to Google Forms:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Server error during submission' },
      { status: 500 },
    );
  }
}

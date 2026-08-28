/**
 * TASK-402 - public surface of the CMS ingest service.
 *
 * Framework-agnostic on purpose. There is no web framework in this repo yet,
 * and multipart parsing is the one part of an upload endpoint that genuinely
 * differs between Express, Fastify, Next and Hono. So the service takes a file
 * that is already on disk or already in memory, and the controller stays about
 * ten lines wherever it ends up:
 *
 *   app.post('/api/waypoints/:id/audio', async (req, res) => {
 *     const file = req.file;                      // multer, busboy, whatever
 *     const token = req.headers.authorization?.replace('Bearer ', '');
 *
 *     try {
 *       const result = await ingestQueue.run(() =>
 *         ingestWaypointAudio({
 *           accessToken:  token,
 *           tourId:       req.body.tourId,
 *           waypointId:   req.params.id,
 *           sortOrder:    Number(req.body.sortOrder),
 *           waypointName: req.body.waypointName,
 *           source: { path: file.path, filename: file.originalname, deleteAfter: true },
 *         }),
 *       );
 *       res.json(result);
 *     } catch (error) {
 *       if (isCmsIngestError(error) || isMediaPipelineError(error)) {
 *         res.status(statusFor(error.code)).json({ code: error.code, message: error.message });
 *         return;
 *       }
 *       throw error;
 *     }
 *   });
 *
 * `ingestQueue` is `createProcessingQueue()` from backend/media, created ONCE
 * at module scope. Calling ingestWaypointAudio directly from a handler gives an
 * upload endpoint no backpressure at all: ten concurrent uploads become ten
 * ffmpeg processes, the box thrashes, and every other request slows down in a
 * way that looks like a database problem and is not.
 */

export { CmsIngestError, isCmsIngestError } from './errors.ts';
export type { CmsErrorCode } from './errors.ts';

export { AUDIO_BUCKET, createAdminScopedClient } from './client.ts';

export { buildAudioStoragePath, isSafeStoragePath, slugifyWaypointName } from './storage-path.ts';
export type { StoragePathInput } from './storage-path.ts';

export { removeQuietly, withWorkspace } from './workspace.ts';
export type { Workspace, WorkspaceOptions } from './workspace.ts';

export { ingestWaypointAudio } from './audio-ingest.ts';
export type { AudioIngestRequest, AudioIngestResult, AudioIngestSource } from './audio-ingest.ts';

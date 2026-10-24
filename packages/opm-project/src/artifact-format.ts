import type { ArchiveFormat } from '@openpacker/materializer';

/** The archive format of a downloaded artifact, from its URL and media type. */
export function inferFormat(source: string, mediaType?: string): ArchiveFormat {
  const lower = source.toLowerCase();
  // Gzip first: media types like "...+gzip" also contain "zip" and must not
  // be classified as zip archives. Plain `.tar` / `...layout.v1.tar` is
  // uncompressed — matching on the substring "tar" alone would mis-label an
  // OCI image layout as gzip and fail extraction.
  if (
    mediaType?.includes('gzip') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.crate')
  )
    return 'tar+gzip';
  if (
    mediaType === 'application/x-tar' ||
    mediaType === 'application/vnd.oci.image.layout.v1.tar' ||
    (mediaType?.includes('tar') && !mediaType.includes('gzip')) ||
    (lower.endsWith('.tar') && !lower.endsWith('.tar.gz'))
  )
    return 'tar';
  if (
    mediaType === 'application/zip' ||
    mediaType?.includes('zip') ||
    lower.endsWith('.zip') ||
    lower.endsWith('.nupkg') ||
    lower.endsWith('.whl')
  )
    return 'zip';
  return 'tar';
}

export function mediaTypeForEcosystem(ecosystem: string): string {
  switch (ecosystem) {
    case 'npm':
      return 'application/vnd.npm.package+gzip';
    case 'cargo':
      return 'application/vnd.crates.io.crate+gzip';
    case 'nuget':
      return 'application/vnd.nuget.package+zip';
    case 'pypi':
      return 'application/zip';
    case 'oci':
      return 'application/vnd.oci.image.layout.v1.tar';
    default:
      return 'application/octet-stream';
  }
}

import {
  createEmbeddedResolver,
  type EmbeddedBindings,
  type EmbeddedResolver,
} from './index.js';

type NativeModule = EmbeddedBindings & { default?: EmbeddedBindings };
export type NativeImporter = () => Promise<NativeModule>;

/** Load the host Node-API addon. This entry point is intentionally Node-only. */
export async function loadNativeEmbeddedResolver(
  importer?: NativeImporter,
): Promise<EmbeddedResolver> {
  const load =
    importer ??
    (async () => {
      const specifier = './native-loader.js';
      return (await import(specifier)) as NativeModule;
    });
  const module = await load();
  return createEmbeddedResolver(module.default ?? module);
}

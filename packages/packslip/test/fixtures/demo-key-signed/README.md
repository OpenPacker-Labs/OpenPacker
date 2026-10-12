# Key-signed demo release

Produced offline with the reference CLI (`packslip` 1.5.1):

```sh
packslip keygen -o demo.key
packslip create --project example.com/tools/demo --version 1.0.0 \
  --key demo.key --no-log --bin demo \
  --resource 'man=archive:demo-1.0.0/share/man/man1/demo.1' \
  --resource 'completion/zsh=archive:demo-1.0.0/share/zsh/_demo' \
  --url-base https://dl.example.com/tools/demo/1.0.0 \
  --out out demo-1.0.0-linux-x64.tar.gz:linux/x86_64/gnu
```

The secret key is deliberately not kept: it only ever signed this one throwaway
fixture, and the tests that need to sign generate their own keys. `--no-log`
means the signature was never published to a public transparency log.

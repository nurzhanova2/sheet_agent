# Release rollback

The previous known-good mechanism is a retained, signed GitHub Release containing its installer and checksum. There is no earlier GA release at Stage 19, so version 0.3.0 cannot claim a production predecessor; retain each approved release from this point forward.

For a bad release, immediately mark the GitHub Release as a prerelease or remove it from public availability, keep its tag and evidence for audit, and stop promotion. Do not replace binaries under an existing tag. Fix forward with a new patch tag when possible.

For installer or Excel integration regression, close Excel, uninstall the bad version, verify files/Office registration/certificate cleanup, verify the previous installer checksum and signature, install it, restart Excel, and repeat the native smoke checklist. Same-AppId upgrades are supported; downgrades must use uninstall/reinstall to avoid newer files surviving.

Provider-only regression can be rolled back independently at the LiteLLM gateway/model routing layer if its configuration contract remains compatible. Never restore or copy DPAPI credential files between Windows users. If configuration format changes in a future version, document migration and backup before release. Record the affected version, release URL, hashes, decision owner, user impact, and the restored known-good version.

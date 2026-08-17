# Vercel custom-domain verification

To verify `www.blacklord.tech` for the BLACKLORD TECH INC Vercel project, add this DNS record at the domain's DNS provider:

| Type | Name / Host | Value |
|---|---|---|
| TXT | `_vercel.www` | `vc-domain-verify=www.blacklord.tech,9933abf2c2482156c7f0` |

If the DNS provider requires a fully qualified name, use `_vercel.www.blacklord.tech`. Keep the value exactly as shown. DNS changes can take a few minutes to propagate; Vercel recommends waiting and then selecting **Verify & Claim** in the project's **Settings → Domains** page.

This TXT record is a DNS ownership record. It cannot be activated by adding HTML or JavaScript to the repository. The custom domain must also be added to the Vercel project, with the DNS CNAME or nameserver configuration shown by Vercel for the project.

The latest application code is deployed by pushing the `main` branch to the connected GitHub repository.

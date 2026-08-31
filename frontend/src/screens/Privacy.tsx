import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PrivacyFr } from "./privacy/Privacy-fr";
import { PrivacyPtBR } from "./privacy/Privacy-pt-BR";

export function Privacy() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language ?? "en";
  return (
    <div className="privacy-page">
      <div className="privacy-inner">
        <Link to="/login" className="privacy-back">
          <ArrowLeft size={14} /> {t("login.backToFootmania")}
        </Link>

        <article className="card privacy-card">
          {lang === "fr" ? <PrivacyFr /> : lang === "pt-BR" ? <PrivacyPtBR /> : <PrivacyEn />}
        </article>
      </div>
    </div>
  );
}

function PrivacyEn() {
  return (
    <>
      <h1>Privacy Policy</h1>

          <p>
            <strong>Last Updated: August 25, 2026</strong>
          </p>

          <p>
            This Privacy Policy explains how <strong>Marcelo V. N. M. Canario, an individual operating Footmania</strong> ("Footmania," "we," "us," or "our")
            collects, uses, stores, discloses, and otherwise processes information when you access or use Footmania, including our website, game,
            applications, APIs, and related services (collectively, the "Service").
          </p>

          <p>By accessing or using the Service, you acknowledge the practices described in this Privacy Policy.</p>

          <h2>1. Information We Collect</h2>

          <h3>1.1 Information You Provide</h3>
          <p>We may collect information you provide directly to us, including:</p>
          <ul>
            <li>account and profile information;</li>
            <li>username and display name;</li>
            <li>club name, club branding, and other game-related information;</li>
            <li>email address;</li>
            <li>preferences and account settings;</li>
            <li>communications you send to us;</li>
            <li>support requests;</li>
            <li>feedback;</li>
            <li>billing information if paid features are introduced; and</li>
            <li>any other information you voluntarily submit through the Service.</li>
          </ul>
          <p>You are responsible for ensuring that information you provide is accurate and that you have the right to provide it.</p>

          <h3>1.2 Information Received From Authentication Providers</h3>
          <p>
            The Service may allow you to sign in using third-party identity providers such as Google, Facebook, Apple, or other providers.
          </p>
          <p>When you use such a login method, we may receive information authorized by you and made available by that provider.</p>
          <p>For Google Sign-In, we intend to request only basic authentication information necessary to identify, create, or authenticate your Footmania account, which may include:</p>
          <ul>
            <li>your Google account identifier;</li>
            <li>email address;</li>
            <li>email verification status;</li>
            <li>name; and</li>
            <li>profile image.</li>
          </ul>
          <p>
            We do not use Google Sign-In to access your Gmail messages, Google Drive files, contacts, calendar, or other unrelated Google services
            unless we separately introduce such functionality, update this Privacy Policy where required, and obtain any consent required by
            applicable law or Google policies.
          </p>
          <p>
            Our use and transfer of information received from Google APIs will comply with the Google API Services User Data Policy, including
            applicable Limited Use requirements.
          </p>
          <p>
            Third-party authentication providers process information under their own privacy policies and terms. We do not control their independent
            privacy practices.
          </p>

          <h3>1.3 Automatically Collected Information</h3>
          <p>When you access or use the Service, we or service providers acting on our behalf may automatically collect technical and usage information such as:</p>
          <ul>
            <li>IP address;</li>
            <li>browser type and version;</li>
            <li>operating system;</li>
            <li>device type;</li>
            <li>language;</li>
            <li>referring URLs;</li>
            <li>access times;</li>
            <li>pages or screens viewed;</li>
            <li>authentication events;</li>
            <li>game activity;</li>
            <li>match and market activity;</li>
            <li>errors and crash information;</li>
            <li>approximate geographic information derived from IP address;</li>
            <li>session identifiers; and</li>
            <li>other technical information reasonably necessary to operate, secure, analyze, or improve the Service.</li>
          </ul>

          <h3>1.4 Payment and Subscription Information</h3>
          <p>Footmania may offer paid subscriptions, premium features, or other paid services in the future.</p>
          <p>If and when paid services become available, payments may be processed by third-party payment processors or application stores.</p>
          <p>Depending on the payment method used, those providers may collect information such as:</p>
          <ul>
            <li>payment-card information;</li>
            <li>billing address;</li>
            <li>payment account information; and</li>
            <li>other information required to process the transaction.</li>
          </ul>
          <p>We may receive and retain information relating to transactions, such as:</p>
          <ul>
            <li>transaction identifiers;</li>
            <li>subscription status;</li>
            <li>subscription tier;</li>
            <li>payment amount;</li>
            <li>currency;</li>
            <li>billing period;</li>
            <li>transaction date;</li>
            <li>payment status;</li>
            <li>refund status;</li>
            <li>payment-provider customer identifier; and</li>
            <li>limited billing information made available by the payment processor.</li>
          </ul>
          <p>
            Unless expressly stated otherwise, full payment-card credentials may be processed directly by the applicable payment provider rather than
            by Footmania.
          </p>
          <p>Payment providers operate under their own terms and privacy policies.</p>

          <h3>1.5 Cookies and Similar Technologies</h3>
          <p>We may use cookies, local storage, authentication tokens, session storage, and similar technologies for purposes including:</p>
          <ul>
            <li>maintaining login sessions;</li>
            <li>remembering settings;</li>
            <li>operating Service functionality;</li>
            <li>fraud and abuse prevention;</li>
            <li>security;</li>
            <li>payment and subscription functionality;</li>
            <li>troubleshooting;</li>
            <li>measuring performance; and</li>
            <li>understanding how the Service is used.</li>
          </ul>
          <p>Where applicable law requires consent for particular technologies, we will request such consent as required.</p>

          <h2>2. How We Use Information</h2>
          <p>To the extent permitted by applicable law, we may process information for purposes including:</p>
          <ul>
            <li>creating and administering accounts;</li>
            <li>authenticating users;</li>
            <li>operating and delivering the Service;</li>
            <li>maintaining game state, clubs, leagues, standings, matches, transfers, auctions, competitions, and other game functionality;</li>
            <li>processing and administering subscriptions and payments;</li>
            <li>maintaining billing and transaction records;</li>
            <li>preventing payment fraud and chargeback abuse;</li>
            <li>communicating with users;</li>
            <li>sending operational or account-related notices;</li>
            <li>responding to support requests;</li>
            <li>detecting, investigating, and preventing cheating, abuse, fraud, account compromise, security incidents, or violations of our Terms;</li>
            <li>enforcing our agreements and policies;</li>
            <li>debugging and improving the Service;</li>
            <li>analyzing Service usage;</li>
            <li>developing new features;</li>
            <li>protecting our rights, property, users, systems, and Service;</li>
            <li>complying with tax, accounting, legal, and regulatory obligations;</li>
            <li>establishing, exercising, or defending legal claims; and</li>
            <li>carrying out a business transaction such as a merger, acquisition, restructuring, financing, or sale of assets.</li>
          </ul>
          <p>
            We may use aggregated or de-identified information for any lawful purpose to the extent that such information can no longer reasonably be
            linked to an identifiable individual.
          </p>

          <h2>3. Legal Bases</h2>
          <p>Where applicable law requires us to identify a legal basis for processing, processing may be based on one or more of:</p>
          <ul>
            <li>performance of a contract with you;</li>
            <li>steps taken at your request before entering into a contract;</li>
            <li>your consent;</li>
            <li>compliance with legal obligations;</li>
            <li>protection of vital interests; and</li>
            <li>
              our legitimate interests, including operating, securing, improving, protecting, and commercially supporting the Service, provided those
              interests are not overridden by rights granted to you under applicable law.
            </li>
          </ul>
          <p>
            Where processing is based on consent, you may withdraw that consent where permitted by law. Withdrawal does not affect processing that
            lawfully occurred before withdrawal.
          </p>

          <h2>4. How We Share Information</h2>
          <p>We do <strong>not sell your personal information in exchange for money</strong>.</p>
          <p>We may disclose information when reasonably necessary to the following categories of recipients.</p>

          <h3>Service Providers</h3>
          <p>Companies and individuals that provide services on our behalf, including providers of:</p>
          <ul>
            <li>hosting and infrastructure;</li>
            <li>databases;</li>
            <li>authentication;</li>
            <li>email delivery;</li>
            <li>payment processing;</li>
            <li>subscription management;</li>
            <li>analytics;</li>
            <li>error monitoring;</li>
            <li>security;</li>
            <li>fraud prevention;</li>
            <li>content delivery;</li>
            <li>backups; and</li>
            <li>technical support.</li>
          </ul>
          <p>These providers may process information as necessary to perform their services for us.</p>

          <h3>Payment Providers</h3>
          <p>If paid services are introduced, we may exchange information with payment processors, financial institutions, or application stores as necessary to:</p>
          <ul>
            <li>process transactions;</li>
            <li>administer subscriptions;</li>
            <li>issue refunds;</li>
            <li>prevent fraud;</li>
            <li>resolve disputes;</li>
            <li>manage chargebacks; and</li>
            <li>comply with legal or accounting obligations.</li>
          </ul>

          <h3>Authentication Providers</h3>
          <p>
            We may exchange information with authentication providers as necessary to authenticate accounts, maintain account connections, prevent
            fraud, or comply with provider requirements.
          </p>

          <h3>Legal and Safety Purposes</h3>
          <p>We may preserve, use, or disclose information if we reasonably believe doing so is necessary or appropriate to:</p>
          <ul>
            <li>comply with applicable law, regulation, court order, legal process, or governmental request;</li>
            <li>enforce our Terms or other agreements;</li>
            <li>collect amounts legally owed to us;</li>
            <li>detect or investigate fraud, cheating, security incidents, or illegal activity;</li>
            <li>protect the rights, property, security, or safety of Footmania, our users, third parties, or the public; or</li>
            <li>establish, exercise, or defend legal claims.</li>
          </ul>
          <p>Where legally permitted, we determine whether and how to respond to requests for information.</p>

          <h3>Business Transfers</h3>
          <p>
            If all or part of Footmania or its operator is involved in a merger, incorporation, financing, acquisition, reorganization, bankruptcy,
            sale of assets, transfer, or similar transaction, information may be disclosed or transferred as part of that transaction.
          </p>
          <p>
            This specifically includes transferring the Service and its associated information from the current individual operator to a future
            corporation or other legal entity established to own or operate Footmania.
          </p>
          <p>
            Any successor may continue processing information in accordance with this Privacy Policy or a replacement privacy policy, subject to
            applicable law.
          </p>

          <h2>5. Public Information</h2>
          <p>Certain features of Footmania are inherently multiplayer and public.</p>
          <p>Information such as your:</p>
          <ul>
            <li>display name;</li>
            <li>club name;</li>
            <li>club colors and branding;</li>
            <li>league or division;</li>
            <li>standings;</li>
            <li>match results;</li>
            <li>transfers;</li>
            <li>achievements;</li>
            <li>game statistics; and</li>
            <li>other game activity</li>
          </ul>
          <p>may be visible to other users or publicly accessible.</p>
          <p>
            Do not use personally identifying information as a public username, club name, or other public-facing game field unless you are
            comfortable making it public.
          </p>
          <p>
            To the maximum extent permitted by law, we are not responsible for how other users independently use information you intentionally make
            public.
          </p>

          <h2>6. Data Retention</h2>
          <p>We may retain information for as long as reasonably necessary for the purposes described in this Privacy Policy, including for:</p>
          <ul>
            <li>operating your account;</li>
            <li>administering active or expired subscriptions;</li>
            <li>maintaining game integrity;</li>
            <li>maintaining historical league and match records;</li>
            <li>processing transactions;</li>
            <li>tax and accounting requirements;</li>
            <li>fraud and abuse prevention;</li>
            <li>chargeback or payment disputes;</li>
            <li>dispute resolution;</li>
            <li>backups;</li>
            <li>security;</li>
            <li>legal compliance; and</li>
            <li>enforcement of our agreements.</li>
          </ul>
          <p>Deleting an account does not necessarily cause every copy or record involving the account to disappear immediately.</p>
          <p>Information may remain in:</p>
          <ul>
            <li>backups;</li>
            <li>security logs;</li>
            <li>fraud-prevention records;</li>
            <li>transaction histories;</li>
            <li>accounting records;</li>
            <li>legal records;</li>
            <li>game history; or</li>
            <li>records we are otherwise legally entitled or required to retain.</li>
          </ul>
          <p>We may retain anonymized or aggregated information indefinitely where it no longer identifies you.</p>

          <h2>7. Account Deletion</h2>
          <p>You may request deletion of your account through:</p>
          <p><strong>[ACCOUNT DELETION METHOD OR EMAIL]</strong></p>
          <p>
            Upon a valid deletion request, we will delete or de-identify personal information as required by applicable law, subject to information
            that we are entitled or required to retain.
          </p>
          <p>
            Because Footmania is intended to operate as a persistent multiplayer game, some historical game records may remain after account deletion
            where reasonably necessary to preserve:
          </p>
          <ul>
            <li>league history;</li>
            <li>standings;</li>
            <li>match records;</li>
            <li>transactions;</li>
            <li>transfers;</li>
            <li>competitive integrity; or</li>
            <li>records involving other users.</li>
          </ul>
          <p>Where appropriate, such records may be detached from your active account, anonymized, or pseudonymized.</p>
          <p>
            Account deletion does not necessarily erase transaction, billing, tax, fraud-prevention, or accounting records that we are legally
            entitled or required to retain.
          </p>

          <h2>8. Security</h2>
          <p>
            We use administrative, technical, and organizational measures that we consider reasonable having regard to the nature of the Service and
            information involved.
          </p>
          <p>
            However, no software, network, database, storage system, payment system, or method of transmission can be guaranteed to be completely
            secure.
          </p>
          <p>
            Accordingly, <strong>we do not guarantee that unauthorized access, loss, disclosure, alteration, security incidents, or other
            compromises will never occur</strong>.
          </p>
          <p>You are responsible for protecting access to your:</p>
          <ul>
            <li>devices;</li>
            <li>email accounts;</li>
            <li>authentication-provider accounts;</li>
            <li>payment accounts; and</li>
            <li>credentials.</li>
          </ul>

          <h2>9. International Processing</h2>
          <p>The Service and its service providers may operate in multiple countries.</p>
          <p>
            Your information may therefore be processed, transferred to, or stored in countries outside New Brunswick or Canada, including countries
            that may provide different levels of privacy protection.
          </p>
          <p>Where applicable law requires safeguards for an international transfer, we will use safeguards required by that law.</p>

          <h2>10. Your Privacy Rights</h2>
          <p>Depending on where you reside, applicable law may give you rights concerning your personal information, potentially including rights to:</p>
          <ul>
            <li>access information;</li>
            <li>correct inaccurate information;</li>
            <li>request deletion;</li>
            <li>withdraw consent;</li>
            <li>restrict certain processing;</li>
            <li>object to certain processing;</li>
            <li>obtain a portable copy of certain information; or</li>
            <li>complain to an applicable privacy authority.</li>
          </ul>
          <p>These rights are subject to exceptions and limitations under applicable law.</p>
          <p>We may request information reasonably necessary to verify your identity before processing a request.</p>
          <p>We may decline or limit requests where permitted by law, including requests that are:</p>
          <ul>
            <li>fraudulent;</li>
            <li>abusive;</li>
            <li>repetitive;</li>
            <li>technically infeasible;</li>
            <li>disproportionately burdensome; or</li>
            <li>detrimental to the rights of others.</li>
          </ul>

          <h2>11. Age Requirement</h2>
          <p><strong>Footmania is intended only for persons who are at least 16 years old.</strong></p>
          <p>You may not create an account or use the Service if you are under 16.</p>
          <p>We do not knowingly seek to collect personal information from persons under 16.</p>
          <p>
            If we reasonably believe that an account belongs to a person under 16, we may suspend or delete the account and associated information,
            subject to information that we are legally permitted or required to retain.
          </p>
          <p>If you believe a person under 16 has provided personal information to us, contact:</p>
          <p><strong>[PRIVACY EMAIL]</strong></p>

          <h2>12. Third-Party Services and Links</h2>
          <p>
            The Service may integrate with or link to third-party websites, platforms, identity providers, payment providers, application stores,
            services, or content.
          </p>
          <p>Those third parties operate independently from us.</p>
          <p>Their collection and use of information is governed by their own policies.</p>
          <p>
            To the maximum extent permitted by applicable law, we are not responsible for their acts, omissions, availability, security, content, or
            privacy practices.
          </p>

          <h2>13. Changes to This Privacy Policy</h2>
          <p>We may modify this Privacy Policy from time to time.</p>
          <p>When we do, we may update the "Last Updated" date and provide additional notice where required by applicable law.</p>
          <p>
            Unless applicable law requires otherwise, an updated Privacy Policy becomes effective when posted or on a later date specified in the
            policy.
          </p>
          <p>
            Your continued use of the Service after an updated policy becomes effective constitutes acknowledgment of that policy to the extent
            permitted by applicable law.
          </p>

          <h2>14. Mandatory Rights</h2>
          <p>
            Nothing in this Privacy Policy is intended to limit privacy, consumer, or other statutory rights that cannot lawfully be waived or
            restricted.
          </p>
          <p>
            If a provision conflicts with mandatory applicable law, that law will control only to the extent of the conflict, and the remaining
            provisions will continue to apply to the maximum extent permitted by law.
          </p>

          <h2>15. Contact</h2>
          <p>Footmania is currently operated by an individual rather than a corporation.</p>
          <p><strong>Operator:</strong> Marcelo V. N. M. Canario, operating Footmania</p>
          <p><strong>Jurisdiction:</strong> New Brunswick, Canada</p>
          <p><strong>Email:</strong> contact@footmania.app</p>
    </>
  );
}

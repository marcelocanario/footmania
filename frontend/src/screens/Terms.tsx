import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TermsFr } from "./terms/Terms-fr";
import { TermsPtBR } from "./terms/Terms-pt-BR";

export function Terms() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language ?? "en";
  return (
    <div className="privacy-page">
      <div className="privacy-inner">
        <Link to="/login" className="privacy-back">
          <ArrowLeft size={14} /> {t("login.backToFootmania")}
        </Link>

        <article className="card privacy-card">
          {lang === "fr" ? <TermsFr /> : lang === "pt-BR" ? <TermsPtBR /> : <TermsEn />}
        </article>
      </div>
    </div>
  );
}

function TermsEn() {
  return (
    <>
      <h1>Terms of Service</h1>

      <p>
        <strong>Last Updated: September 2, 2026</strong>
      </p>

      <p>
        These Terms of Service ("Terms") govern your access to and use of Footmania, including its website, game, applications, APIs, features, and related
        services (collectively, the "Service").
      </p>

      <p>
        The Service is currently operated by <strong>Marcelo V. N. M. Canario, an individual operating Footmania in New Brunswick, Canada</strong> ("Footmania,"
        "we," "us," or "our").
      </p>

      <p>By creating an account, accessing the Service, or otherwise using the Service, you agree to these Terms.</p>

      <p>If you do not agree, do not use the Service.</p>

      <h2>1. Eligibility</h2>

      <p><strong>You must be at least 16 years old to use Footmania.</strong></p>

      <p>By creating an account or using the Service, you represent and warrant that:</p>
      <ul>
        <li>you are at least 16 years old;</li>
        <li>you are legally capable of agreeing to these Terms;</li>
        <li>information you provide is accurate;</li>
        <li>your use of the Service complies with applicable law; and</li>
        <li>you are not prohibited from using the Service under applicable sanctions, export-control, or other laws.</li>
      </ul>

      <p>We may refuse, restrict, or terminate access where permitted by law.</p>

      <h2>2. Accounts</h2>

      <p>You may be required to create an account or authenticate through a third-party identity provider.</p>

      <p>You are responsible for activity occurring through your account and for maintaining control of:</p>
      <ul>
        <li>your devices;</li>
        <li>your email account;</li>
        <li>linked authentication accounts; and</li>
        <li>credentials associated with the Service.</li>
      </ul>

      <p>You may not sell, transfer, rent, sublicense, share, or commercially exploit an account except where expressly permitted by us.</p>

      <p>
        We may determine, in our reasonable discretion, that multiple accounts are controlled by the same person or coordinated group for anti-cheating,
        fraud-prevention, market-integrity, enforcement, or similar purposes.
      </p>

      <p>
        To the maximum extent permitted by law, we are not responsible for losses resulting from unauthorized access to your account unless caused by conduct for
        which applicable law prevents us from excluding responsibility.
      </p>

      <h2>3. License to Use the Service</h2>

      <p>
        Subject to these Terms, we grant you a limited, personal, revocable, non-exclusive, non-transferable, and non-sublicensable right to access and use the
        Service for its intended purposes.
      </p>

      <p>This is a license, not a transfer or sale of ownership.</p>

      <p>All rights not expressly granted are reserved by us and our licensors.</p>

      <h2>4. Game Rules and Operator Authority</h2>

      <p>
        Footmania is a persistent multiplayer simulation whose rules, economy, algorithms, schedules, competitions, probabilities, balancing systems, and other
        mechanics may evolve.
      </p>

      <p>To the maximum extent permitted by law, we may:</p>
      <ul>
        <li>create, change, rebalance, remove, or replace mechanics;</li>
        <li>modify player attributes and development;</li>
        <li>modify team values and economic parameters;</li>
        <li>change competition structures;</li>
        <li>modify rewards or progression;</li>
        <li>alter probabilities or simulation models;</li>
        <li>correct unintended outcomes;</li>
        <li>reverse, cancel, modify, or invalidate transactions affected by bugs, exploits, cheating, errors, or unintended mechanics;</li>
        <li>reschedule, replay, cancel, or administratively determine matches or events;</li>
        <li>reorganize leagues or divisions;</li>
        <li>migrate or reset game state where reasonably necessary;</li>
        <li>correct database or simulation errors;</li>
        <li>introduce or remove features;</li>
        <li>change eligibility requirements;</li>
        <li>change limitations; and</li>
        <li>take actions reasonably necessary to preserve security, competitive integrity, or the viability of the Service.</li>
      </ul>

      <p>No:</p>
      <ul>
        <li>mechanic;</li>
        <li>attribute;</li>
        <li>virtual item;</li>
        <li>game currency;</li>
        <li>player;</li>
        <li>ranking;</li>
        <li>reward;</li>
        <li>economy;</li>
        <li>competition structure;</li>
        <li>probability;</li>
        <li>feature; or</li>
        <li>other aspect of the Service</li>
      </ul>
      <p>is guaranteed to remain unchanged.</p>

      <p>
        Game-integrity and enforcement decisions may be made using automated systems, statistical analysis, manual review, or a combination of these methods.
      </p>

      <h2>5. Fair Play and Prohibited Conduct</h2>

      <p>You may not:</p>
      <ul>
        <li>cheat;</li>
        <li>knowingly exploit bugs or unintended mechanics;</li>
        <li>manipulate matches, auctions, transfers, rankings, or markets;</li>
        <li>operate coordinated accounts for an unfair advantage;</li>
        <li>use sham transactions to move value between accounts;</li>
        <li>automate gameplay except through functionality expressly permitted by us;</li>
        <li>use unauthorized bots, scrapers, scripts, clients, or automation;</li>
        <li>interfere with servers, networks, APIs, or security controls;</li>
        <li>reverse engineer the Service except where applicable law expressly permits it despite this restriction;</li>
        <li>probe or test vulnerabilities without authorization;</li>
        <li>circumvent access, account, technical, geographic, or gameplay restrictions;</li>
        <li>impersonate another person;</li>
        <li>harass or threaten others;</li>
        <li>submit illegal, infringing, defamatory, or abusive content;</li>
        <li>use the Service for fraud or unlawful conduct;</li>
        <li>attempt to gain unauthorized access to another account; or</li>
        <li>assist another person in violating these Terms.</li>
      </ul>

      <p>We determine whether conduct violates these rules in our reasonable discretion.</p>

      <h2>6. Suspension and Termination</h2>

      <p>We may restrict, suspend, disable, modify, reset, or terminate an account, temporarily or permanently, where we reasonably believe:</p>
      <ul>
        <li>these Terms were violated;</li>
        <li>cheating, exploitation, manipulation, or abuse occurred;</li>
        <li>activity presents security, legal, reputational, operational, or financial risk;</li>
        <li>an account has been compromised;</li>
        <li>investigation is required;</li>
        <li>amounts lawfully owed to us remain unpaid;</li>
        <li>a payment was fraudulent;</li>
        <li>continued service to the user is impractical; or</li>
        <li>doing so is otherwise permitted by applicable law.</li>
      </ul>

      <p>Where permitted, enforcement may occur without advance notice.</p>

      <p>
        We are not required to restore lost progress, rankings, virtual items, opportunities, or other game state resulting from valid enforcement.
      </p>

      <p>Nothing in these Terms requires us to provide the Service to a particular user indefinitely.</p>

      <h2>7. Virtual Items, Game Currency and Game Progress</h2>

      <p>Unless expressly stated otherwise, anything existing solely within the Service — including:</p>
      <ul>
        <li>game currency;</li>
        <li>players;</li>
        <li>clubs;</li>
        <li>player values;</li>
        <li>contracts;</li>
        <li>rankings;</li>
        <li>points;</li>
        <li>achievements;</li>
        <li>trophies;</li>
        <li>statistics;</li>
        <li>transfer rights;</li>
        <li>auction positions;</li>
        <li>rewards; and</li>
        <li>other virtual items or game state</li>
      </ul>
      <p>has <strong>no monetary value outside the Service</strong> and does not constitute:</p>
      <ul>
        <li>money;</li>
        <li>property;</li>
        <li>stored value;</li>
        <li>a security;</li>
        <li>an investment;</li>
        <li>a deposit; or</li>
        <li>a financial account.</li>
      </ul>

      <p>You acquire no ownership interest in such game elements.</p>

      <p>
        We may modify, rebalance, remove, expire, reset, or discontinue virtual elements as reasonably necessary to operate the Service.
      </p>

      <p>
        You may not sell or exchange accounts, virtual items, game currency, or game-related rights for real-world value unless expressly authorized by us.
      </p>

      <h2>8. Future Paid Services and Subscriptions</h2>

      <p>Footmania does not necessarily offer paid services at the time these Terms are published.</p>

      <p>We may introduce subscriptions, premium features, or other paid services in the future ("Paid Services").</p>

      <p>If Paid Services become available, the specific:</p>
      <ul>
        <li>price;</li>
        <li>currency;</li>
        <li>billing period;</li>
        <li>features;</li>
        <li>trial terms, if any;</li>
        <li>renewal terms; and</li>
        <li>other material purchase terms</li>
      </ul>
      <p>will be disclosed during the applicable purchase process.</p>

      <h3>8.1 Recurring Subscriptions</h3>
      <p>
        Where a subscription is identified as automatically renewing, you authorize the applicable payment provider to charge the applicable recurring
        subscription fee, plus applicable taxes, using your selected payment method until the subscription is cancelled or otherwise terminated.
      </p>
      <p>Automatic renewal will apply only where disclosed as part of the subscription offer and permitted by applicable law.</p>

      <h3>8.2 Cancellation</h3>
      <p>You may cancel an automatically renewing subscription using the cancellation method made available for the applicable subscription.</p>
      <p>Unless otherwise stated during purchase or required by law:</p>
      <ul>
        <li>cancellation prevents future renewals;</li>
        <li>cancellation does not retroactively cancel charges already incurred; and</li>
        <li>access to paid subscription benefits continues until the end of the already-paid billing period.</li>
      </ul>
      <p>
        Deleting your Footmania account does not necessarily constitute cancellation of a subscription handled by a third-party application store or payment
        provider. Where applicable, you must also cancel through that provider.
      </p>

      <h3>8.3 Refunds</h3>
      <p>Except where:</p>
      <ul>
        <li>required by applicable law;</li>
        <li>expressly stated otherwise during purchase; or</li>
        <li>required under the rules of an applicable application store or payment provider,</li>
      </ul>
      <p><strong>payments are final and non-refundable.</strong></p>
      <p>Unless required by law, we are not obligated to provide:</p>
      <ul>
        <li>prorated refunds;</li>
        <li>credits for partially used periods;</li>
        <li>refunds for unused subscription time;</li>
        <li>refunds because you stopped using the Service;</li>
        <li>refunds resulting from account suspension or termination caused by your violation of these Terms; or</li>
        <li>compensation for changes to game balance, virtual items, or game mechanics.</li>
      </ul>
      <p>Nothing in this section limits mandatory refund, cancellation, or consumer rights that cannot lawfully be waived.</p>

      <h3>8.4 Prices and Subscription Changes</h3>
      <p>We may change prices, subscription tiers, included features, or billing periods.</p>
      <p>Price changes affecting future renewals will be communicated in the manner and with the notice required by applicable law.</p>
      <p>Unless applicable law requires otherwise, a price change will not retroactively increase a fee for a billing period already paid.</p>
      <p>If you do not accept a future subscription price, you may cancel before the changed price applies.</p>

      <h3>8.5 Free Trials and Promotional Offers</h3>
      <p>If we offer a trial or promotional period, additional terms may apply.</p>
      <p>Where a free or discounted trial automatically becomes a paid subscription, the purchase interface will disclose the applicable conversion and renewal terms.</p>
      <p>Unless applicable law provides otherwise, failure to cancel before the disclosed conversion date may result in the applicable recurring charge.</p>
      <p>We may determine eligibility for promotional offers and may limit, modify, withdraw, or refuse promotions where permitted by law.</p>

      <h3>8.6 Failed Payments</h3>
      <p>If a payment cannot be processed, we may:</p>
      <ul>
        <li>retry the payment;</li>
        <li>request another payment method;</li>
        <li>suspend Paid Services;</li>
        <li>downgrade the account;</li>
        <li>terminate the subscription; or</li>
        <li>take other reasonable actions to collect amounts lawfully due.</li>
      </ul>

      <h3>8.7 Taxes</h3>
      <p>Displayed prices may or may not include applicable taxes depending on how and where a purchase is made.</p>
      <p>You are responsible for taxes, duties, or similar governmental charges associated with a purchase except taxes imposed directly on our income.</p>

      <h3>8.8 Third-Party Billing</h3>
      <p>Payments may be processed by third parties such as payment processors or application stores.</p>
      <p>Where purchases are processed through such a provider, its:</p>
      <ul>
        <li>billing rules;</li>
        <li>cancellation process;</li>
        <li>payment methods; and</li>
        <li>refund requirements</li>
      </ul>
      <p>may also apply.</p>
      <p>Where mandatory provider rules or applicable law conflict with these Terms, those mandatory requirements control to the extent of the conflict.</p>

      <h3>8.9 Chargebacks and Payment Abuse</h3>
      <p>You must not knowingly initiate a fraudulent, deceptive, or abusive payment dispute or chargeback.</p>
      <p>
        Where we reasonably determine that a transaction or chargeback is fraudulent or abusive, we may restrict or terminate the associated account and take
        reasonable steps to recover amounts legally owed.
      </p>
      <p>
        Nothing in this provision restricts your lawful right to dispute an unauthorized, incorrect, or otherwise legitimately disputed charge.
      </p>

      <h3>8.10 Paid Features Do Not Create Ownership Rights</h3>
      <p>Payment for Paid Services provides only the access or benefits expressly described in the applicable offer.</p>
      <p>Payment does not grant ownership of:</p>
      <ul>
        <li>your Footmania account;</li>
        <li>game data;</li>
        <li>game currency;</li>
        <li>virtual players;</li>
        <li>virtual items;</li>
        <li>leagues;</li>
        <li>rankings;</li>
        <li>game mechanics;</li>
        <li>intellectual property; or</li>
        <li>any portion of the Service.</li>
      </ul>
      <p>
        Unless expressly stated otherwise, paid benefits remain subject to the game-management, balancing, modification, suspension, and termination provisions
        of these Terms.
      </p>

      <h2>9. No Guarantee of Results or Persistence</h2>

      <p>Footmania includes simulations, probability-based outcomes, automated systems, competitive interactions, and actions by other users.</p>

      <p>We do not guarantee:</p>
      <ul>
        <li>match results;</li>
        <li>promotion or relegation;</li>
        <li>player development;</li>
        <li>auction results;</li>
        <li>transfer availability;</li>
        <li>rankings;</li>
        <li>rewards;</li>
        <li>game balance;</li>
        <li>economic value;</li>
        <li>continuous historical records;</li>
        <li>uninterrupted seasons;</li>
        <li>preservation of game state; or</li>
        <li>any particular competitive outcome.</li>
      </ul>

      <p>Game data may be modified or lost because of:</p>
      <ul>
        <li>maintenance;</li>
        <li>bugs;</li>
        <li>database failures;</li>
        <li>balancing;</li>
        <li>enforcement;</li>
        <li>migrations;</li>
        <li>resets;</li>
        <li>attacks;</li>
        <li>infrastructure failures; or</li>
        <li>other operational events.</li>
      </ul>

      <p>You use the Service with this understanding.</p>

      <h2>10. User Content</h2>

      <p>
        "User Content" means content you submit or make available through the Service, including names, descriptions, club designs, logos, messages, feedback,
        and other materials.
      </p>

      <p>You retain ownership rights you may have in User Content.</p>

      <p>You grant us a worldwide, non-exclusive, royalty-free, transferable, and sublicensable license to host, store, reproduce, adapt, modify, display, distribute, communicate, and otherwise use User Content as reasonably necessary to:</p>
      <ul>
        <li>operate the Service;</li>
        <li>display it to users;</li>
        <li>promote or demonstrate the Service;</li>
        <li>moderate content;</li>
        <li>enforce rules;</li>
        <li>maintain backups;</li>
        <li>improve the Service; and</li>
        <li>comply with legal obligations.</li>
      </ul>

      <p>You represent that you possess all rights required to provide User Content and grant this license.</p>

      <p>We may remove or restrict User Content where permitted by law.</p>

      <h2>11. Feedback</h2>

      <p>
        If you provide suggestions, concepts, feature requests, ideas, bug reports, or other feedback, you grant us a worldwide, perpetual, irrevocable,
        transferable, sublicensable, and royalty-free license to use, modify, disclose, commercialize, and incorporate that feedback without restriction or
        compensation.
      </p>

      <p>You are not entitled to royalties, compensation, ownership, or attribution because we use feedback you provided.</p>

      <h2>12. Intellectual Property</h2>

      <p>
        The Service, including its software, source code, design, interfaces, systems, text, graphics, logos, databases, and other protectable materials, is
        owned by us or our licensors and protected by applicable intellectual-property laws.
      </p>

      <p>Except for the limited rights expressly granted under these Terms, you receive no rights in the Service or our intellectual property.</p>

      <p>"Footmania" and related branding may not be used in a manner suggesting endorsement, affiliation, or authorization without permission.</p>

      <h2>13. Third-Party Services</h2>

      <p>
        The Service may interact with third-party providers, including authentication providers, payment processors, application stores, hosting providers,
        analytics services, and infrastructure providers.
      </p>

      <p>Your use of those providers may also be subject to their terms.</p>

      <p>We do not control third-party services.</p>

      <p>To the maximum extent permitted by law, we are not responsible for their:</p>
      <ul>
        <li>availability;</li>
        <li>security;</li>
        <li>functionality;</li>
        <li>content;</li>
        <li>conduct;</li>
        <li>omissions; or</li>
        <li>changes.</li>
      </ul>

      <h2>14. Service Availability</h2>

      <p>The Service is provided on an <strong>"as available"</strong> basis.</p>

      <p>We do not promise a particular:</p>
      <ul>
        <li>uptime;</li>
        <li>latency;</li>
        <li>response time;</li>
        <li>capacity;</li>
        <li>retention period;</li>
        <li>backup frequency;</li>
        <li>recovery time; or</li>
        <li>service level</li>
      </ul>
      <p>unless we expressly agree otherwise in writing.</p>

      <p>We may interrupt the Service for:</p>
      <ul>
        <li>maintenance;</li>
        <li>upgrades;</li>
        <li>security;</li>
        <li>capacity limitations;</li>
        <li>provider outages;</li>
        <li>legal requirements;</li>
        <li>emergencies; or</li>
        <li>other operational reasons.</li>
      </ul>

      <h2>15. Changes and Discontinuation</h2>

      <p>Subject to mandatory applicable law, we may modify, replace, suspend, discontinue, or cease operating any or all of the Service.</p>

      <p>We do not guarantee that Footmania, any particular feature, or any particular Paid Service will remain available indefinitely.</p>

      <p>
        To the maximum extent permitted by law, we are not liable for losses relating to game progress, expectations, rankings, opportunities, virtual items, or
        game history resulting from modification or discontinuation.
      </p>

      <p>Any rights concerning prepaid Paid Services that cannot legally be excluded remain unaffected.</p>

      <h2>16. Disclaimer of Warranties</h2>

      <p>
        <strong>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS,
          IMPLIED, STATUTORY, OR OTHERWISE.
        </strong>
      </p>

      <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM WARRANTIES INCLUDING:</p>
      <ul>
        <li>MERCHANTABILITY;</li>
        <li>FITNESS FOR A PARTICULAR PURPOSE;</li>
        <li>TITLE;</li>
        <li>NON-INFRINGEMENT;</li>
        <li>ACCURACY;</li>
        <li>RELIABILITY;</li>
        <li>AVAILABILITY;</li>
        <li>SECURITY; and</li>
        <li>QUIET ENJOYMENT.</li>
      </ul>

      <p>WE DO NOT WARRANT THAT:</p>
      <ul>
        <li>THE SERVICE WILL BE UNINTERRUPTED;</li>
        <li>THE SERVICE WILL BE ERROR-FREE;</li>
        <li>DEFECTS WILL BE CORRECTED;</li>
        <li>DATA WILL NEVER BE LOST;</li>
        <li>THE SERVICE WILL BE COMPLETELY SECURE;</li>
        <li>RESULTS WILL BE ACCURATE;</li>
        <li>THE SERVICE WILL MEET YOUR EXPECTATIONS; OR</li>
        <li>THIRD-PARTY SERVICES WILL REMAIN AVAILABLE.</li>
      </ul>

      <p>Some jurisdictions do not permit certain warranty exclusions, in which case those exclusions apply only to the maximum extent legally permitted.</p>

      <h2>17. Limitation of Liability</h2>

      <p>
        <strong>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, WE AND OUR OWNERS, SUCCESSORS, DIRECTORS, OFFICERS, EMPLOYEES, CONTRACTORS, AFFILIATES, LICENSORS,
          AND SERVICE PROVIDERS WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES OR FOR LOSS OF PROFITS,
          REVENUE, BUSINESS, OPPORTUNITY, GOODWILL, DATA, GAME PROGRESS, VIRTUAL ITEMS, OR OTHER INTANGIBLE LOSSES.
        </strong>
      </p>

      <p>This applies regardless of:</p>
      <ul>
        <li>the theory of liability;</li>
        <li>whether the loss was foreseeable; or</li>
        <li>whether we were advised that the loss could occur.</li>
      </ul>

      <p>
        <strong>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, OUR TOTAL AGGREGATE LIABILITY ARISING FROM OR RELATING TO THE SERVICE OR THESE TERMS WILL NOT EXCEED
          THE GREATER OF:
        </strong>
      </p>

      <ol>
        <li><strong>the amount you actually paid directly to us for the Service during the twelve months immediately preceding the event giving rise to the claim; or</strong></li>
        <li><strong>CAD $100.</strong></li>
      </ol>

      <p>The limitations apply collectively across claims arising from or relating to the Service.</p>

      <p>Nothing in these Terms excludes liability that applicable law prohibits us from excluding or limiting.</p>

      <h2>18. Indemnification</h2>

      <p>
        To the maximum extent permitted by applicable law, you agree to defend, indemnify, and hold harmless us and our successors, owners, officers, employees,
        contractors, affiliates, and agents from claims, liabilities, losses, damages, judgments, costs, and reasonable legal expenses arising from:
      </p>
      <ul>
        <li>your unlawful use of the Service;</li>
        <li>your material violation of these Terms;</li>
        <li>your User Content;</li>
        <li>infringement or violation of another person's rights;</li>
        <li>fraud, abuse, cheating, or manipulation committed through your account; or</li>
        <li>your intentional misconduct.</li>
      </ul>

      <p>This obligation does not apply to the extent a claim results from conduct for which applicable law prohibits us from obtaining indemnification.</p>

      <p>We may control the defense and settlement of an indemnified matter, and you agree to reasonably cooperate.</p>

      <h2>19. Disputes Between Users</h2>

      <p>We are not a party to disputes between users merely because those disputes arise through the Service.</p>

      <p>We may, but are not obligated to, investigate or intervene in user disputes.</p>

      <p>Game-administration decisions do not create a duty to resolve legal, financial, contractual, or personal disputes between users.</p>

      <h2>20. Governing Law and Jurisdiction</h2>

      <p>
        These Terms and disputes arising from or relating to these Terms or the Service are governed by the laws of the <strong>Province of New Brunswick and the
        applicable federal laws of Canada</strong>, without regard to conflict-of-law principles.
      </p>

      <p>
        Subject to rights that cannot lawfully be waived, you and we agree to the exclusive jurisdiction of the courts of <strong>New Brunswick, Canada</strong>{" "}
        for disputes arising from these Terms or the Service.
      </p>

      <p>
        Nothing in this section deprives a consumer of mandatory protections or jurisdictional rights that applicable law does not permit the consumer to waive.
      </p>

      <h2>21. Informal Dispute Resolution</h2>

      <p>Before commencing formal proceedings, you agree, where legally permitted, to provide written notice describing the dispute and requested resolution to:</p>

      <p><strong>contact@footmania.app</strong></p>

      <p>You and we will attempt in good faith to resolve the dispute informally for at least <strong>30 days</strong> after receipt of the notice.</p>

      <p>Either party may seek urgent injunctive or protective relief where delay could reasonably cause irreparable harm.</p>

      <h2>22. Changes to These Terms</h2>

      <p>We may modify these Terms from time to time.</p>

      <p>For ordinary changes, revised Terms become effective when posted or on a later date specified by us.</p>

      <p>Where applicable law requires advance notice, affirmative consent, or another procedure for a material change, we will follow that requirement.</p>

      <p>Your continued use of the Service after revised Terms become effective constitutes acceptance where legally permitted.</p>

      <p>If you do not agree to revised Terms, you must stop using the Service and may close your account.</p>

      <h2>23. Future Change of Operator</h2>

      <p>Footmania is currently operated by an individual.</p>

      <p>We may later incorporate, establish, or transfer operation of Footmania to a corporation or other legal entity.</p>

      <p>To the maximum extent permitted by applicable law, we may assign or transfer:</p>
      <ul>
        <li>these Terms;</li>
        <li>the Service;</li>
        <li>user accounts;</li>
        <li>contractual rights;</li>
        <li>contractual obligations;</li>
        <li>associated business assets; and</li>
        <li>related records</li>
      </ul>
      <p>to that successor entity without requiring separate consent from every user.</p>

      <p>Any mandatory notice or consent required by applicable law will still be provided or obtained.</p>

      <h2>24. Assignment</h2>

      <p>You may not assign or transfer these Terms or your rights under them without our prior written consent.</p>

      <p>We may assign or transfer these Terms in connection with:</p>
      <ul>
        <li>incorporation;</li>
        <li>restructuring;</li>
        <li>financing;</li>
        <li>merger;</li>
        <li>acquisition;</li>
        <li>sale of assets;</li>
        <li>transfer of the Service; or</li>
        <li>change of operator,</li>
      </ul>
      <p>or otherwise where permitted by law.</p>

      <h2>25. No Waiver</h2>

      <p>Failure to enforce a provision does not waive our right to enforce it later.</p>

      <p>A waiver is effective only if expressly made in writing.</p>

      <h2>26. Severability</h2>

      <p>
        If a provision is found invalid, illegal, or unenforceable, it will be enforced to the maximum extent legally permissible or modified to the minimum
        extent necessary to make it enforceable.
      </p>

      <p>The remaining provisions will continue in effect.</p>

      <h2>27. No Third-Party Beneficiaries</h2>

      <p>Except where expressly stated otherwise, these Terms do not create enforceable rights for persons or entities other than you and us.</p>

      <h2>28. Force Majeure</h2>

      <p>To the maximum extent permitted by law, we are not responsible for delay, interruption, failure, or loss caused by events beyond our reasonable control, including:</p>
      <ul>
        <li>internet outages;</li>
        <li>hosting failures;</li>
        <li>cloud-provider failures;</li>
        <li>cyberattacks;</li>
        <li>denial-of-service attacks;</li>
        <li>power failures;</li>
        <li>telecommunications failures;</li>
        <li>natural disasters;</li>
        <li>fires;</li>
        <li>floods;</li>
        <li>war;</li>
        <li>terrorism;</li>
        <li>civil unrest;</li>
        <li>labour disputes;</li>
        <li>governmental action;</li>
        <li>epidemics;</li>
        <li>pandemics;</li>
        <li>payment-provider failures; or</li>
        <li>third-party service failures.</li>
      </ul>

      <h2>29. Entire Agreement</h2>

      <p>
        These Terms, together with the Privacy Policy and any additional terms expressly incorporated into them, constitute the agreement between you and us
        concerning the Service and supersede prior agreements or representations concerning the same subject matter.
      </p>

      <h2>30. Interpretation</h2>

      <p>Headings are for convenience only.</p>

      <p>"Including" means "including without limitation."</p>

      <p>Provisions intended by their nature to survive termination survive, including those concerning:</p>
      <ul>
        <li>intellectual property;</li>
        <li>feedback;</li>
        <li>accrued payment obligations;</li>
        <li>disclaimers;</li>
        <li>liability limitations;</li>
        <li>indemnification; and</li>
        <li>dispute resolution.</li>
      </ul>

      <p>Nothing in these Terms limits non-waivable statutory rights.</p>

      <h2>31. Contact</h2>

      <p>Footmania is currently operated by an individual rather than a corporation.</p>

      <p><strong>Operator:</strong> Marcelo V. N. M. Canario, operating Footmania</p>
      <p><strong>Jurisdiction:</strong> New Brunswick, Canada</p>
      <p><strong>Email:</strong> contact@footmania.app</p>
      <p><strong>Website:</strong> https://footmania.app</p>
    </>
  );
}

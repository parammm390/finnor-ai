# collusion-side-information-2026

Source: https://arxiv.org/html/2511.12456v4
Fetch status: 200
Retention basis: FetchUrl-rendered Markdown, not original PDF/source bytes.

Title:

Content selection saved. Describe the issue below:

Description:

![](https://arxiv.org/static/base/1.0.1/images/icons/smileybones-small.svg)arXiv is now an independent nonprofit! [Learn more](https://info.arxiv.org/about) ×

[License: CC BY 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2511.12456v4 \[cs.GT\] 07 May 2026

# Collusion-Proof Auction Design using Side Information

Sukanya Kudva
Affiliation: University of California, Berkeley
Email: [sukanya\_kudva@berkeley.edu](mailto:)Edward Dowling
Affiliation: University of California, Berkeley
Email: [ed\_dowling@berkeley.edu](mailto:)Anil Aswani
Affiliation: University of California, Berkeley
Email: [aaswani@berkeley.edu](mailto:)

###### Abstract

Existing auction mechanisms are vulnerable to bidder collusion, which substantially degrades revenue and non-colluder welfare. To design truthful mechanisms resilient to collusion, we introduce a novel approach that leverages a machine learning classifier to predict (even imprecisely) which bidders are colluding. We first establish a Bulow-Klemperer-type result for multi-unit auctions with single-minded bidders, demonstrating that collusion significantly harms existing mechanisms only when the colluding coalition is large. Consequently, we focus our design on settings with many colluders. Building on the welfare-optimal Vickrey-Clarke-Groves (VCG) mechanism, we propose two novel truthful mechanisms: VCG-Posted Price (V-PoP) and Conditional-Posted Price (C-PoP). V-PoP applies VCG to non-colluding bidders and posted prices to colluding ones, and ensuring truthfulness is non-trivial because we must dynamically split the quantity of items between these groups based on the values of the non-colluder bids. C-PoP further advances this by computing a posted price conditioned on non-colluder bids, and ensuring truthfulness is non-obvious because the posted price is chosen using the values of the non-colluder bids. Because real-world classifiers make errors, we provide theoretical lower bounds on the auction price of V-PoP and C-PoP under misclassification, which theory shows acts as a proxy for welfare and revenue. Crucially, our bounds yield actionable insights for classifier design, revealing that false negatives (misclassifying colluders as non-colluders) are preferable to false positives (misclassifying non-colluders as colluders). Numerical experiments demonstrate that our mechanisms achieve high welfare and revenue against collusion, even when utilizing simple, low-cost classifiers.

## 1 Introduction

It is challenging to design auction mechanisms in settings where bidders may collude. For instance, though the Vickrey-Clarke-Groves (VCG) mechanism ( [Vickrey, 1961](https://arxiv.org/html/2511.12456v4#bib.bib8 ""); [Groves, 1973](https://arxiv.org/html/2511.12456v4#bib.bib9 "")) maximizes the auctioneer’s revenue among all welfare-maximizing auctions ( [Krishna and Perry, 1997](https://arxiv.org/html/2511.12456v4#bib.bib12 "")) and is dominant strategy incentive compatibility (DSIC) for all bidders (i.e., truth-telling is the best strategy for the bidders regardless of what others report), it is known to be both theoretically and practically vulnerable to collusion ( [Friedman, 1964](https://arxiv.org/html/2511.12456v4#bib.bib6 ""); [Robinson, 1985](https://arxiv.org/html/2511.12456v4#bib.bib10 ""); [Hendricks and Porter, 1989](https://arxiv.org/html/2511.12456v4#bib.bib7 ""); [Goswami et al., 1996](https://arxiv.org/html/2511.12456v4#bib.bib5 "")). Posted-price auctions give bidders a fixed take-it-or-leave-it price ( [Goldberg and Hartline, 2004](https://arxiv.org/html/2511.12456v4#bib.bib11 "")), and they are collusion-proof when either a single item or infinitely-many items are being bid on. Yet they are vulnerable to collusion when a fixed number (greater than one) of items are being bid on, and worse still is that even in the absence of collusion the posted-price mechanism often performs poorly with respect to welfare ( [Kertz, 1986](https://arxiv.org/html/2511.12456v4#bib.bib3 ""); [Blumrosen and Holenstein, 2008](https://arxiv.org/html/2511.12456v4#bib.bib4 "")).

Given the general lack of progress on auction mechanisms that generate high welfare and revenue in the presence of collusion, we take a novel approach in this paper: We leverage a machine learning classifier to predict (even imprecisely) which bidders are colluding. Our goal is to then design mechanisms that offer the same price to all bidders who receive an item and can achieve high welfare/revenue even when the classifier is imperfect, and are DSIC for all bidders (even the colluders) when the classifier is perfect. The importance of DSIC under perfect classification is it makes it practically difficult for colluders to manipulate the auction under imperfect classification.

### 1.1 Mechanism Design with Side Information

Recent literature has increasingly explored the design of mechanisms using side information to bypass the limitations of existing auction designs. Prior work in this domain has primarily focused on side information regarding bidder types – specifically, parameters related to preferences or item valuations ( [Devanur et al., 2016](https://arxiv.org/html/2511.12456v4#bib.bib15 ""); [Xu and Lu, 2022](https://arxiv.org/html/2511.12456v4#bib.bib16 ""); [Balcan et al., 2023](https://arxiv.org/html/2511.12456v4#bib.bib14 "")). For instance, information about correlated types has been leveraged to identify the weakest bidders and enhance the efficiency of the VCG mechanism ( [Balcan et al., 2023](https://arxiv.org/html/2511.12456v4#bib.bib14 ""); [Xu and Lu, 2022](https://arxiv.org/html/2511.12456v4#bib.bib16 "")). Additionally, [Devanur et al. (2016)](https://arxiv.org/html/2511.12456v4#bib.bib15 "") leverage side information to distinguish bidders along a continuum in revenue-maximizing auctions. Beyond standard auctions, learning-augmented algorithms have utilized side information to achieve strategy-proofness in application-specific domains, such as job scheduling ( [Balkanski et al., 2023](https://arxiv.org/html/2511.12456v4#bib.bib17 "")) and facility location ( [Agrawal et al., 2024](https://arxiv.org/html/2511.12456v4#bib.bib18 ""); [Tang et al., 2020a](https://arxiv.org/html/2511.12456v4#bib.bib37 "")). Our work is novel because it is the first to consider side information on which bidders are colluding, and our work also expands the area of learning-augmented mechanism design because the side information on collusion may be generated by a machine learning classifier that makes imperfect predictions.

### 1.2 Collusion-Resistant Mechanisms

Relatively little research has focused on designing auction mechanisms robust to bidder collusion. In the strongest collusion model, colluding bidders act to maximize a single, joint utility function, assuming that they can exchange items and execute side payments among themselves. Given the difficulty of designing mechanisms under this model, the literature frequently considers weaker notions of collusion-resistance, such as tt-truthfulness and group strategy-proofness ( [Goldberg and Hartline, 2004](https://arxiv.org/html/2511.12456v4#bib.bib11 "")). Under tt-truthfulness, where any coalition of size at most tt maximizes its expected utility by bidding truthfully, researchers have leveraged consensus techniques to propose approximately efficient and optimal mechanisms ( [Goldberg and Hartline, 2004](https://arxiv.org/html/2511.12456v4#bib.bib11 "")). Group strategy-proofness requires that any deviation benefiting one coalition member must strictly harm another ( [Goldberg and Hartline, 2004](https://arxiv.org/html/2511.12456v4#bib.bib11 ""); [Juarez, 2013](https://arxiv.org/html/2511.12456v4#bib.bib27 ""); [Basu and Mukherjee, 2024](https://arxiv.org/html/2511.12456v4#bib.bib26 "")). Mechanisms satisfying this property have been studied across various domains, including auctions ( [Goldberg and Hartline, 2004](https://arxiv.org/html/2511.12456v4#bib.bib11 "")), network design games ( [Pal and Tardos, 2003](https://arxiv.org/html/2511.12456v4#bib.bib21 ""); [Cheng et al., 2013](https://arxiv.org/html/2511.12456v4#bib.bib23 ""); [Tang et al., 2020b](https://arxiv.org/html/2511.12456v4#bib.bib22 "")) and queueing models ( [Kayı and Ramaekers, 2010](https://arxiv.org/html/2511.12456v4#bib.bib25 ""); [Mitra and Mutuswami, 2011](https://arxiv.org/html/2511.12456v4#bib.bib24 "")). Departing from past work, this paper designs auction mechanisms robust to the strongest model of bidder collusion by leveraging side information.

### 1.3 Collusion Detection via Machine Learning

Extensive research has addressed collusion detection using statistical and machine learning techniques, particularly within public procurement auctions ( [Conley and Decarolis, 2016](https://arxiv.org/html/2511.12456v4#bib.bib28 ""); [Chassang et al., 2022](https://arxiv.org/html/2511.12456v4#bib.bib29 ""); [Lyra et al., 2022](https://arxiv.org/html/2511.12456v4#bib.bib31 "")). For instance, [García Rodríguez et al. (2022)](https://arxiv.org/html/2511.12456v4#bib.bib30 "") provides a comparative analysis of machine learning approaches, while [Bonjour et al. (2022)](https://arxiv.org/html/2511.12456v4#bib.bib32 "") proposes a game-theoretic framework based on mutual information. More recently, the focus has expanded to tacit algorithmic collusion ( [Calvano et al., 2018](https://arxiv.org/html/2511.12456v4#bib.bib34 ""); [Assad et al., 2024](https://arxiv.org/html/2511.12456v4#bib.bib33 "")), prompting the development of novel detection methods based on statistical testing ( [Hespanhol and Aswani, 2020](https://arxiv.org/html/2511.12456v4#bib.bib2 ""); [Hartline et al., 2024](https://arxiv.org/html/2511.12456v4#bib.bib35 "")). Building on this extensive and growing body of literature, it is now reasonable to assume that an auctioneer can gain access to a machine learning classifier capable of identifying colluders in an auction. Our work is the first to leverage such classifiers to design inherently collusion-robust auction mechanisms.

### 1.4 Contributions and Outline

Our main contributions include the following: We establish a Bulow-Klemperer-type result ( [Bulow and Klemperer, 1996](https://arxiv.org/html/2511.12456v4#bib.bib19 "")) for multi-unit auctions with single-minded bidders, demonstrating that collusion significantly harms existing mechanisms only when the colluding coalition is large. Using this insight, we propose two novel, collusion-robust mechanisms: VCG-Posted Price (V-PoP) and Conditional-Posted Price (C-PoP). When the classifier makes no errors, we prove that V-PoP and C-PoP are truthful even under a strong model of collusion. This is important because, as we discuss later, it makes it practically difficult for colluders to manipulate V-PoP and C-PoP when there is misclassification. We provide theoretical lower bounds on the auction price of V-PoP and C-PoP under misclassification, which are a proxy for welfare and revenue. These bounds give insights into the classifier design, implying that false negatives (misclassifying colluders as non-colluders) are preferable to false positives (misclassifying non-colluders as colluders). We also conduct numerical experiments that show the robustness of our mechanisms to collusion even when using simple, low-cost classifiers.

Section [2](https://arxiv.org/html/2511.12456v4#S2 "2 Preliminaries ‣ Collusion-Proof Auction Design using Side Information") introduces the auction setting and the model of bidder collusion. Section [3](https://arxiv.org/html/2511.12456v4#S3 "3 Performance of VCG with Collusion ‣ Collusion-Proof Auction Design using Side Information") presents our Bulow-Klemperer-type result, motivating our focus on settings with a high number of colluders. In Section [4](https://arxiv.org/html/2511.12456v4#S4 "4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), we formally define the VCG-Posted Price (V-PoP) and Conditional-Posted Price (C-PoP) mechanisms and study them theoretically. Section [5](https://arxiv.org/html/2511.12456v4#S5 "5 Numerical Experiments ‣ Collusion-Proof Auction Design using Side Information") contains numerical experiments that illustrate the strong welfare and revenue performance of our mechanism in the presence of misclassification.

## 2 Preliminaries

We consider a single-item, multiple-unit auction, where rr identical copies of the same item are being sold. There are mm single-minded bidders, each of whom desires at most one item. Bidder ii has a private valuation viv\_{i} for the item, bids bib\_{i} for the item, and is charged payment pip\_{i} on winning it. Define the bid b=(b1,⋯,bm)b=(b\_{1},\\cdots,b\_{\\textsc{m}}) and true valuation vectors v=(v1,⋯,vm)v=(v\_{1},\\cdots,v\_{\\textsc{m}}), respectively, and let 𝖬\\mathsf{M} with \|𝖬\|=m\|\\mathsf{M}\|=m be the set of all bidders. Designing an auction mechanism comprises choosing two components: an allocation scheme xi​(b)∈{0,1}x\_{i}(b)\\in\\{0,1\\}, and a payment scheme pi​(b)∈ℝp\_{i}(b)\\in\\mathbb{R} for each bidder ii. These allocation and payment schemes must be specified before the bids are collected, the design of an auction mechanism generally relates to participants’ utilities:

###### Definition 2.1(Utility of Bidders).

The utility of bidder ii is ui​(bi,bi−)=vi​xi​(bi,bi−)−pi​(bi,bi−)u\_{i}(b\_{i},b\_{i-})=v\_{i}x\_{i}(b\_{i},b\_{i-})-p\_{i}(b\_{i},b\_{i-}), where bi−b\_{i-} are the bids of all other bidders except ii.

###### Definition 2.2(Utility of Auctioneer).

The auctioneer’s utility is ua​(b)=∑i∈𝖬pi​(b)u\_{a}(b)=\\sum\_{i\\in\\mathsf{M}}p\_{i}(b).

Auctions that maximize welfare and revenue are referred to as efficient and optimal auctions, respectively. This paper focuses on efficiency while maximizing revenue to the extent possible.

###### Definition 2.3(Welfare).

Welfare is the total utility of all participants (i.e., all bidders and the auctioneer). Hence, welfare is 𝚆𝚎𝚕⁡(b)=ua​(b)+∑i∈𝖬ui​(b)=∑i∈𝖬vi​xi​(b)\\mathtt{Wel}(b)=u\_{a}(b)+\\sum\_{i\\in\\mathsf{M}}u\_{i}(b)=\\sum\_{i\\in\\mathsf{M}}v\_{i}x\_{i}(b).

###### Definition 2.4(Revenue).

Revenue is the total payment made to the auctioneer: 𝚁𝚎𝚟⁡(b)=ua​(b)=∑i∈𝖬pi​(b)\\mathtt{Rev}(b)=u\_{a}(b)=\\sum\_{i\\in\\mathsf{M}}p\_{i}(b), and it is the same as the auctioneer’s utility in our model.

We assume bidders are rational in that they maximize a corresponding utility. We assume 𝖬\\mathsf{M} is partitioned into two disjoint subsets: the non-colluding bidders 𝖭\\mathsf{N} and the colluding bidders 𝖢\\mathsf{C}, with 𝖬=𝖭∪𝖢\\mathsf{M}=\\mathsf{N}\\cup\\mathsf{C} and m=\|𝖬\|=\|𝖭\|+\|𝖢\|=n+cm=\|\\mathsf{M}\|=\|\\mathsf{N}\|+\|\\mathsf{C}\|=n+c. Let bnb^{\\textsc{n}} and bcb^{\\textsc{c}} be the vectors of bids submitted by the non-colluding and colluding bidders, respectively. True valuations vnv^{\\textsc{n}} and vcv^{\\textsc{c}} are defined similarly.

###### Definition 2.5(Model of Non-Colluding Bidders).

We assume that each non-colluding bidder i∈𝖭i\\in\\mathsf{N} submits bid bib\_{i} to maximize their utility ui​(bi,bi−)=vi​xi​(bi,bi−)−pi​(bi,bi−)u\_{i}(b\_{i},b\_{i-})=v\_{i}x\_{i}(b\_{i},b\_{i-})-p\_{i}(b\_{i},b\_{i-}).

###### Definition 2.6(Model of Colluding Bidders).

We assume that the colluding bidders act as a unified entity that maximizes the sum of their individual utilities uc​(bc,bn)=∑i∈𝖢vi​xi​(bc,bn)−pi​(bc,bn)u\_{\\textsc{c}}(b^{\\textsc{c}},b^{\\textsc{n}})=\\sum\_{i\\in\\mathsf{C}}v\_{i}x\_{i}(b^{\\textsc{c}},b^{\\textsc{n}})-p\_{i}(b^{\\textsc{c}},b^{\\textsc{n}}), allowing for both information exchange and monetary transfers amongst them.

We next introduce notation based on order statistics to allow for clear reference to ranked bids and valuations. For any set of bidders SS, let bksb^{\\textsc{s}}\_{k} and vksv^{\\textsc{s}}\_{k} be the kt​hk^{th}-largest bid and true valuations within SS, respectively. Define 𝖡rs={b1s,⋯,brs}\\mathsf{B}^{\\textsc{s}}\_{r}=\\{b^{\\textsc{s}}\_{1},\\cdots,b^{\\textsc{s}}\_{r}\\} and 𝖵rs={v1s,⋯,vrs}\\mathsf{V}^{\\textsc{s}}\_{r}=\\{v^{\\textsc{s}}\_{1},\\cdots,v^{\\textsc{s}}\_{r}\\} to be the sets of the top rr bids and true valuations from SS, respectively. The complements of these sets are defined as 𝖡rs¯=𝖡ss∖𝖡rs={br+1s,⋯,bns}\\overline{\\mathsf{B}^{\\textsc{s}}\_{r}}=\\mathsf{B}^{\\textsc{s}}\_{s}\\setminus\\mathsf{B}^{\\textsc{s}}\_{r}=\\{b^{\\textsc{s}}\_{r+1},\\cdots,b^{\\textsc{s}}\_{n}\\} and similarly, 𝖵rs¯=𝖵ss∖𝖵rs={vr+1s,⋯,vns}\\overline{\\mathsf{V}^{\\textsc{s}}\_{r}}=\\mathsf{V}^{\\textsc{s}}\_{s}\\setminus\\mathsf{V}^{\\textsc{s}}\_{r}=\\{v^{\\textsc{s}}\_{r+1},\\cdots,v^{\\textsc{s}}\_{n}\\}.

To differentiate observed bidders’ valuations vv from their underlying random variables, we use capital letters VV to denote the latter. Also, 𝖵rs\\mathsf{V}^{\\textsc{s}}\_{r} and 𝒱rs\\mathcal{V}^{\\textsc{s}}\_{r} denote sets of observed and random bidders’ valuations. Similarly, notations for observed and random bids and their sets are bb, 𝖡rs\\mathsf{B}^{\\textsc{s}}\_{r} and BB, ℬrs\\mathcal{B}^{\\textsc{s}}\_{r}, respectively.

## 3 Performance of VCG with Collusion

In an auction with rr identical items, the VCG mechanism prescribes allocation xi​(b)=𝟏​(bi∈𝖡rm)x\_{i}(b)=\\mathbf{1}\\left(b\_{i}\\in\\mathsf{B}^{\\textsc{m}}\_{r}\\right), and payment pi​(b)=br+1m​𝟏​(bi∈𝖡rm)p\_{i}(b)=b^{\\textsc{m}}\_{r+1}\\mathbf{1}\\left(b\_{i}\\in\\mathsf{B}^{\\textsc{m}}\_{r}\\right) for each bidder ii.
In the absence of collusion, the mechanism ensures (ex-post) DSIC by guaranteeing each winning bidder ii an information rent of vi−pi​(b)v\_{i}-p\_{i}(b), which incentivizes truth-telling (b=vb=v). This property, in turn, guarantees efficiency since the auction maximizes the welfare ∑ivi​xi​(b)\\sum\_{i}v\_{i}x\_{i}(b) and the items are given to bidders who most value them. However, performance degrades when some bidders collude. Here, we characterize the effects of colluding bidders on welfare and revenue when the VCG auction is conducted without accounting for collusion.

The phenomena of bid shading (bidding a value lower than the true item valuation) and shill bidding (a single bidder entering the auction as multiple bidders) have been studied by [Sher (2012)](https://arxiv.org/html/2511.12456v4#bib.bib36 ""): Substitute items incentivize integration and bid shading (as in our paper), while complement items incentivize disintegration (shill bidding) and possibly higher bids. In the next lemma, we adapt these results to our setting. For completeness, we also provide a simplified proof in the Appendix.

###### Proposition 3.1.

Let rcC​o​lr\_{\\textsc{c}}^{\\scriptscriptstyle Col}(rc∗)(r\_{\\textsc{c}}^{\*}), rnC​o​lr\_{\\textsc{n}}^{\\scriptscriptstyle Col}(rn∗)(r\_{\\textsc{n}}^{\*}) and bC​o​lb^{\\scriptscriptstyle Col}(b∗)(b^{\*}) be the number of items allocated to colluding bidders, the number of items allocated to non-colluding bidders, and the optimal bids in the presence (absence) of collusion, respectively, using the VCG mechanism. Then, the following holds:

1. 1.


Colluding bidders do not obtain more items through collusion (i.e., rcC​o​l≤rc∗r\_{\\textsc{c}}^{\\scriptscriptstyle Col}\\leq r\_{\\textsc{c}}^{\*}). They shade their bids and never bid load (i.e., bic,C​o​l≤vicb^{\\textsc{c},\\scriptscriptstyle Col}\_{i}\\leq v^{\\textsc{c}}\_{i} for i∈Ci\\in C), bidding either 00 or their true valuation vicv^{\\textsc{c}}\_{i}.

2. 2.


The utility of each non-colluding bidder and of the collective of colluding bidders does not decrease due to collusion, meaning that ui​(b∗)≤ui​(bC​o​l)u\_{i}(b^{\*})\\leq u\_{i}(b^{\\scriptscriptstyle Col}) for i∈Ni\\in N and uc​(b∗)≤uc​(bC​o​l)u\_{\\textsc{c}}(b^{\*})\\leq u\_{\\textsc{c}}(b^{\\scriptscriptstyle Col}).

3. 3.


Welfare and revenue are non-increasing, meaning 𝚆𝚎𝚕⁡(b∗)≥𝚆𝚎𝚕⁡(bC​o​l)\\mathtt{Wel}(b^{\*})\\geq\\mathtt{Wel}(b^{\\scriptscriptstyle Col}) and 𝚁𝚎𝚟⁡(b∗)≥𝚁𝚎𝚟⁡(bC​o​l)\\mathtt{Rev}(b^{\*})\\geq\\mathtt{Rev}(b^{\\scriptscriptstyle Col}). The revenue of the auctioneer is hence non-increasing, meaning that ua​(b∗)≥ua​(bC​o​l)u\_{a}(b^{\*})\\geq u\_{a}(b^{\\scriptscriptstyle Col}).


In our setting, the losing colluding bidders optimally shade bids to zero, effectively behaving as a single non-competitive bidder. This leads to an interesting observation that adding non-colluding bidders improves welfare and revenue, and we use this observation to prove a Bulow-Klemperer type result. Let 𝚆𝚎𝚕VCG​(𝖭,𝖢)\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N},\\mathsf{C}) be the welfare of the VCG mechanism when 𝖭\\mathsf{N} is the set of non-colluders and 𝖢\\mathsf{C} is the set of colluders, and let 𝚆𝚎𝚕OPT​(𝖬)\\mathtt{Wel}\_{\\textsc{OPT}}(\\mathsf{M}) be the welfare of a mechanism that is efficient (but possibly not truthful) for a set of bidders 𝖬\\mathsf{M} that may or may not include colluders.

###### Proposition 3.2.

If the bidder valuations viv\_{i} are independent and identically distributed (i.i.d.), then

|     |     |     |     |
| --- | --- | --- | --- |
|  | 𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭∪𝖭′,𝖢)\]≥𝔼⁡\[𝚆𝚎𝚕OPT​(𝖭∪𝖢)\]\\mathbb{E}\\bigl\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N}\\cup\\mathsf{N}^{\\prime},\\mathsf{C})\\bigr\]\\geq\\mathbb{E}\\bigl\[\\mathtt{Wel}\_{\\textsc{OPT}}(\\mathsf{N}\\cup\\mathsf{C})\\bigr\] |  | (1) |

where 𝖭′\\mathsf{N}^{\\prime} is a set of additional non-colluding bidders such that \|𝖭′\|=\|𝖢\|\|\\mathsf{N}^{\\prime}\|=\|\\mathsf{C}\|.

The Bulow-Klemperer theorem ( [Bulow and Klemperer, 1996](https://arxiv.org/html/2511.12456v4#bib.bib19 "")) says that the effort of designing optimal auctions is better spent on recruiting an additional bidder. Our result has a similar interpretation: Recruiting \|𝖢\|\\bigl\|\\mathsf{C}\\bigr\| more non-colluding bidders improves welfare and revenue when compared to an efficient (collusion-aware) auction mechanism. This result can also be interpreted as implying that collusion harms the revenue and welfare of a VCG auction only when the colluding coalition is large. As a result, in the rest of this paper we focus on auction design for settings with many colluders.

## 4 Designing Truthful Auctions under Collusion

Since colluding bidders may misreport their values under the VCG mechanism, we focus on designing new mechanisms that use side information on which bidders are colluding in order to remain truthful even in the presence of collusion. Because of the side information, we can design the auction assuming that we are able to split bidders into the two groups of colluding and non-colluding.

A number of adaptive auction mechanisms compute a price by splitting bidders into two groups, whereby a price or reserve price computed using the bids of the first group is applied to bids in the second group. Because the bids in the second group are not used to compute the price, truthfulness is trivially achieved. In some such mechanisms, bidders in the first group are ineligible to win an item ( [Dhangwatnotai et al., 2015](https://arxiv.org/html/2511.12456v4#bib.bib20 "")), whereas in other such mechanisms, bidders in the second group are used to compute a price that is applied to the first group ( [Goldberg et al., 2006](https://arxiv.org/html/2511.12456v4#bib.bib1 "")). We disfavor the first because it reduces efficiency by choosing bidders who are _by design_ not allowed to receive an item, and we disfavor the second because it means that different prices are applied to different bidders.

In this section, we introduce a new class of auctions that we call the Conditional Posted Price (C-PoP) mechanism. Our mechanism uses a single price for all items received, and it does not disallow (by design) any bidders from receiving an item. Our design differs from existing posted price mechanisms in two key ways. First, we determine the posted price using the bids of non-colluding bidders (hence the name “conditional" posted price). Second, we charge a uniform price to all winning bidders, regardless of their subgroup. Ensuring truthfulness is consequently nontrivial for our mechanism, which can be better appreciated with two examples:

###### Example 4.1.

A mechanism that computes a posted price pp that is (even implicitly) a function of the values of all non-colluder bids bnb^{\\textsc{n}} is not truthful. This is because a winning non-colluding bidder ii may be able strategically bid bib\_{i} in a way that lowers the posted price pp and hence increases their utility ui=vi−pu\_{i}=v\_{i}-p. Thus the posted price of a truthful mechanism must be chosen in such a way that any winning bidder cannot affect this price, which has not been previously done in the literature.

###### Example 4.2.

A mechanism that randomly allocates the rr items to all bids from 𝖭\\mathsf{N} and 𝖢\\mathsf{C} above the posted price pp is not truthful. This is because the colluders could strategically overbid to increase their expected allocation without affecting the price. For instance, consider r=2r=2, and suppose the non-colluding bids are (1,2)(1,2) and the colluding valuations are (1,2,3)(1,2,3). If the price is p=1p=1, then the colluders will bid (3,3,3)(3,3,3) to strictly increase their expected number of allocated items.

### 4.1 Conditional-Posted Price (C-PoP) Mechanism

Algorithm [1](https://arxiv.org/html/2511.12456v4#alg1 "Algorithm 1 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") outlines our C-PoP mechanism. This mechanism first runs a posted price auction at price p∗p^{\*} for the non-colluding bidders 𝖭\\mathsf{N}, and then uses the remaining items to run a second posted price auction at the same price p∗p^{\*} for the colluding bidders 𝖢\\mathsf{C}. It employs a dynamic programming (DP) oracle, outlined in Algorithm [2](https://arxiv.org/html/2511.12456v4#alg2 "Algorithm 2 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), to compute an optimal posted price p∗p^{\*} and a corresponding value k∗k^{\*}. The DP oracle is designed in such a way that the price p∗p^{\*} is computed using only the values of the smallest n−k∗n-k^{\*} non-colluding bids, and it picks the price p∗p^{\*} to optimize over an auctioneer’s objective (e.g., welfare or revenue maximization). We provide simpler alternatives to the DP oracle in Appendix [B.1](https://arxiv.org/html/2511.12456v4#A2.SS1 "B.1 Alternative Approaches to the DP Oracle in Algorithm ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information"), but these alternatives generally generate less welfare/revenue than the DP oracle.

Algorithm 1 Conditional-Posted Price (C-PoP) Mechanism

1:Input: Total number of items rr; non-colluding bidders 𝖭\\mathsf{N} and colluding bidders 𝖢\\mathsf{C} with sealed/unrevealed bids bnb^{\\textsc{n}} and bcb^{\\textsc{c}}; Oracle(bn,n,c)(b^{\\textsc{n}},n,c)

2:Output: Allocation xix\_{i} and payment pip\_{i} for each bidder i∈𝖭∪𝖢i\\in\\mathsf{N}\\cup\\mathsf{C}.

3:


Calculate (k∗,p∗)←(k^{\*},p^{\*})\\leftarrowOracle(bn,n,c)(b^{\\textsc{n}},n,c).

4:Phase 1: Run Posted Price on 𝖭\\mathsf{N} with p∗p^{\*}

5:


Qualifying non-colluding bidders: 𝖶^n←{i∈𝖭∣bin>p∗}\\hat{\\mathsf{W}}\_{\\textsc{n}}\\leftarrow\\{i\\in\\mathsf{N}\\mid b^{\\textsc{n}}\_{i}>p^{\*}\\}.

6:if\|𝖶^n\|>r\|\\hat{\\mathsf{W}}\_{\\textsc{n}}\|>rthen

7:


Winning non-colluding bidders: randomly select a subset 𝖶n⊆𝖶^n\\mathsf{W}\_{\\textsc{n}}\\subseteq\\hat{\\mathsf{W}}\_{\\textsc{n}} of size rr.

8:else

9:𝖶n←𝖶^n\\mathsf{W}\_{\\textsc{n}}\\leftarrow\\hat{\\mathsf{W}}\_{\\textsc{n}}.

10:endif

11:Phase 2: Run Posted Price on 𝖢\\mathsf{C} with remaining max⁡{r−\|𝖶n\|,0}\\max\\{r-\|\\mathsf{W}\_{\\textsc{n}}\|,0\\} items

12:


Qualifying colluding bidders: 𝖶^c←{i∈𝖢∣bic>p∗}\\hat{\\mathsf{W}}\_{\\textsc{c}}\\leftarrow\\{i\\in\\mathsf{C}\\mid b\_{i}^{\\textsc{c}}>p^{\*}\\}.

13:if\|𝖶^c\|>max⁡{r−\|𝖶n\|,0}\|\\hat{\\mathsf{W}}\_{\\textsc{c}}\|>\\max\\{r-\|\\mathsf{W}\_{\\textsc{n}}\|,0\\}then

14:


Winning colluding bidders: randomly select a subset 𝖶c⊆𝖶^c\\mathsf{W}\_{\\textsc{c}}\\subseteq\\hat{\\mathsf{W}}\_{\\textsc{c}} of size max⁡{r−\|𝖶n\|,0}\\max\\{r-\|\\mathsf{W}\_{\\textsc{n}}\|,0\\}.

15:else

16:𝖶c←𝖶^c\\mathsf{W}\_{\\textsc{c}}\\leftarrow\\hat{\\mathsf{W}}\_{\\textsc{c}}.

17:endif

18:


Winners: 𝖶←𝖶n∪𝖶c\\mathsf{W}\\leftarrow\\mathsf{W}\_{\\textsc{n}}\\cup\\mathsf{W}\_{\\textsc{c}}

19:


Allocate items: xi←1x\_{i}\\leftarrow 1 for i∈𝖶i\\in\\mathsf{W}, 00 otherwise.

20:


Charge price: pi←p∗p\_{i}\\leftarrow p^{\*} for i∈𝖶i\\in\\mathsf{W}.

Algorithm 2 Dynamic Programming Oracle(bn,n,cb^{\\textsc{n}},n,c)

1:Input: Total number of items rr; number of non-colluding bidders and colluding bidders nn, cc respectively; non-colluding bids bnb^{\\textsc{n}}; function M⁡(p,𝖡kn¯)M(p,\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}).

2:Output:k∗,p∗k^{\*},p^{\*}

3:fork∈{0,⋯,r}k\\in\\{0,\\cdots,r\\}do

4:pk=arg⁡maxp≥bk+1n⁡M⁡(p,𝖡kn¯)p\_{k}=\\arg\\max\_{p\\geq b^{\\textsc{n}}\_{k+1}}M(p,\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}})

5:endfor

6:Phase 1: Compute value functions V⁡(pk,ℬkn¯)V(p\_{k},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k}})

7:


Set V⁡(p0,ℬ0n¯)=M⁡(p0,ℬ0n¯)=M⁡(p0,ℬnn)V(p\_{0},\\overline{\\mathcal{B}^{\\textsc{n}}\_{0}})=M(p\_{0},\\overline{\\mathcal{B}^{\\textsc{n}}\_{0}})=M(p\_{0},\\mathcal{B}^{\\textsc{n}}\_{n})

8:fork=1,…,rk=1,\\ldots,rdo

9:


Compute
V⁡(pk,ℬkn¯)=max⁡{M⁡(pk,ℬkn¯),𝔼⁡\[V⁡(pk−1,ℬk−1n¯)∣ℬkn¯\]}V(p\_{k},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k}})=\\max\\Big\\{M(p\_{k},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k}}),\\;\\mathbb{E}\\left\[V(p\_{k-1},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k-1}})\\mid\\overline{\\mathcal{B}^{\\textsc{n}}\_{k}}\\right\]\\Big\\}

10:endfor

11:Phase 2: Compute optimal split k∗k^{\*}

12:


Set k∗←rk^{\*}\\leftarrow r

13:whileM⁡(pk,𝖡kn¯)M(p\_{k},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}) <
𝔼⁡\[V⁡(pk−1,ℬk−1n¯)∣𝖡kn¯\]\\mathbb{E}\\left\[V(p\_{k-1},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k-1}})\\mid\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}\\right\]do

14:k∗←k∗−1k^{\*}\\leftarrow k^{\*}-1

15:endwhile

16:p∗←pk∗p^{\*}\\leftarrow p\_{k^{\*}}

In the theorem below, we show that the C-PoP mechanism is truthful for all bidders when the DP oracle is used. We overcome the limitation described in Example [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem1 "Example 4.1. ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") by designing the DP oracle so that the price pp, computed conditional on a non-colluding bid bb, is always chosen to satisfy p≥bp\\geq b. The oracle incrementally expands the set of conditioned non-colluding bids, proceeding from lowest to highest, and commits to a price that is at least as large as each of them. In particular, the dynamic programming approach at each stage kk chooses between stopping and taking the current value M⁡(pk,𝖡kn¯)M\\bigl(p\_{k},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}\\bigr), or continuing to k−1k-1 to obtain the anticipated future value
𝔼⁡\[V⁡(pk−1,𝖡k−1n¯)\|𝖡kn¯\].\\mathbb{E}\\!\\left\[V\\bigl(p\_{k-1},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k-1}}\\bigr)\\,\\middle\|\\,\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}\\right\]. Choosing the latter option commits to k∗≤k−1k^{\*}\\leq k-1, implying that the bidder with bid bknb^{\\textsc{n}}\_{k} does not win. This ensures that if a non-colluding bidder misreports their true valuation, they either incur negative utility, or the resulting price is at least as large as their reported bid. We overcome the limitation described in Example [4.2](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem2 "Example 4.2. ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") by allocating, to the colluding bidders, the items _remaining_ after a posted-price auction is conducted among the non-colluding bidders. As a result, both the allocation and pricing rules for colluding bidders are independent of their bids, which ensures truthfulness.

###### Theorem 4.3(C-PoP Truthfulness).

The C-PoP mechanism implemented with the DP oracle is (ex-post) DSIC for all bidders, including colluding bidders 𝖢\\mathsf{C}, when 𝖭\\mathsf{N} and 𝖢\\mathsf{C} are correctly specified.

However, a given classifier may generate false positives (misclassifying non-colluders as colluders) and false negatives (misclassifying colluders as non-colluders). Let 𝖭t\\mathsf{N}\_{\\textsc{t}}, 𝖭f\\mathsf{N}\_{\\textsc{f}}, 𝖢t\\mathsf{C}\_{\\textsc{t}}, and 𝖢f\\mathsf{C}\_{\\textsc{f}} be the correctly and incorrectly classified non-colluding bidders and colluding bidders, respectively, and suppose C-PoP using the DP oracle is applied to the predicted set of non-colluders 𝖭^=𝖭t∪𝖢f\\widehat{\\mathsf{N}}=\\mathsf{N}\_{\\textsc{t}}\\cup\\mathsf{C}\_{\\textsc{f}} and the predicted set of colluders 𝖢^=𝖭f∪𝖢t\\widehat{\\mathsf{C}}=\\mathsf{N}\_{\\textsc{f}}\\cup\\mathsf{C}\_{\\textsc{t}}. The above theorem about the truthfulness of C-PoP along with the complex structure of the DP oracle in Algorithm [2](https://arxiv.org/html/2511.12456v4#alg2 "Algorithm 2 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") suggests that it will be practically difficult for colluders to manipulate the auction. Indeed, the colluders would not know which of its bidders have been correctly or incorrectly classified by the auctioneer’s classifier, and so the colluder will have limited strategic capabilities in changing the auction price or allocation.

Our next result shows that C-PoP provides additional robustness guarantees under misclassification, namely that it remains DSIC for all non-colluders and ensures a lower bound on the auction price.

###### Proposition 4.4.

Suppose C-PoP using the DP oracle is applied to the predicted set of non-colluders 𝖭^=𝖭t∪𝖢f\\widehat{\\mathsf{N}}=\\mathsf{N}\_{\\textsc{t}}\\cup\\mathsf{C}\_{\\textsc{f}} and the predicted set of colluders 𝖢^=𝖭f∪𝖢t\\widehat{\\mathsf{C}}=\\mathsf{N}\_{\\textsc{f}}\\cup\\mathsf{C}\_{\\textsc{t}}. Then C-PoP remains (ex-post) DSIC for all non-colluders 𝖭\\mathsf{N}. And if \|𝖭t\|≥r+1\|\\mathsf{N}\_{\\textsc{t}}\|\\geq r+1, then we have p∗≥br+1Ntp^{\*}\\geq b^{N\_{\\textsc{t}}}\_{r+1} for the posted price.

This result shows that C-PoP is robust in performance because it ensures that the auction price, which acts as a proxy for welfare and revenue, is bounded from below. The result also provides guidance for classifier design: It is better to generate false negatives than it is to generate false positives.

### 4.2 VCG-Posted Price (V-PoP) Mechanism

When the price points pk=arg⁡maxp≥bk+1n⁡M⁡(p,𝖡kn¯)p\_{\\scriptscriptstyle k}=\\arg\\max\_{p\\,\\geq\\,b^{\\textsc{n}}\_{k+1}}M(p,\\overline{\\mathsf{B}^{\\textsc{n}}\_{\\scriptscriptstyle k}}) are instead set to pk=bk+1np\_{\\scriptscriptstyle k}=b^{\\textsc{n}}\_{\\scriptscriptstyle k+1} in Algorithm [2](https://arxiv.org/html/2511.12456v4#alg2 "Algorithm 2 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), the C-PoP mechanism reduces to a VCG auction over the non-colluding bidders, followed by a posted-price auction for the colluding bidders at the chosen k∗k^{\*}. This follows because the price becomes pk∗=bk∗+1np\_{\\scriptscriptstyle k^{\*}}=b^{\\textsc{n}}\_{\\scriptscriptstyle k^{\*}+1}, which coincides with the VCG price when k∗k^{\*} items are allocated to the non-colluding bidders. The same price is then used to run a posted-price auction among the colluding bidders. We refer to this special case as the VCG–Posted Price (V-PoP) mechanism. When the number of non-colluders is large, V-PoP performs comparably to C-PoP. The intuition is that a larger pool of non-colluding bidders induces a finer coverage of the price space through the discrete price points pkp\_{\\scriptscriptstyle k} determined by their bids. Consequently, the additional price optimization pk=arg⁡maxp≥bk+1n⁡M⁡(p,𝖡kn¯)p\_{\\scriptscriptstyle k}=\\arg\\max\_{p\\,\\geq\\,b^{\\textsc{n}}\_{k+1}}M(p,\\overline{\\mathsf{B}^{\\textsc{n}}\_{\\scriptscriptstyle k}}) in the C-PoP mechanism provides limited marginal benefit and can effectively be neglected.

### 4.3 Expected Welfare Optimization for Known Bid Distribution

In the rest of the paper, we focus on optimizing C-PoP to achieve good welfare guarantees. Let 𝚆𝚎𝚕C-PoP​(𝖭,𝖢,p)\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p) and 𝚁𝚎𝚟C-PoP​(𝖭,𝖢,p)\\mathtt{Rev}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p) be the welfare and revenue, respectively, from the C-PoP mechanism when the price is set at pp. The key idea of our mechanism is to set the value of (k∗,p∗)(k^{\*},p^{\*}) using (conditional) expected welfare (or an appropriate proxy thereof) as M⁡(p,𝖡kn¯)M(p,\\overline{\\mathsf{B}^{\\textsc{n}}\_{\\scriptscriptstyle k}}) in the DP oracle, given in Algorithm [2](https://arxiv.org/html/2511.12456v4#alg2 "Algorithm 2 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), to achieve strong welfare guarantees. We use prior information about the distribution of bidders’ valuations and the observed bids bnb^{\\textsc{n}} to calculate the (conditional) expected welfare at a price pp as in the next lemma. We use the following assumption for this computation.

###### Assumption 4.1.

Suppose the bidders’ valuations are i.i.d. from an invertible cumulative distribution function (CDF) 𝖥⁡(⋅)\\mathsf{F}(\\cdot), with the inverse as the quantile function 𝖰⁡(⋅)\\mathsf{Q}(\\cdot), that is known to the auctioneer. Sufficient conditions for invertibility of 𝖥⁡(⋅)\\mathsf{F}(\\cdot) are monotonicity and continuous differentiability.

###### Proposition 4.5(Conditional Expected Welfare).

If Assumption [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmassumption1 "Assumption 4.1. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") holds, then the expected welfare given the price pp from the C-PoP mechanism can be calculated as follows:

|     |     |     |     |
| --- | --- | --- | --- |
|  | 𝔼\[𝚆𝚎𝚕C-PoP(𝖭,𝖢;p)∣p≥bnk+1,𝖡kn¯\]=𝔼\[𝖰(U)\|U≥𝖥(p)\]×𝔼⁡\[wn+∑ν=1r−wn−1ν⋅ℙ⁡(wc=ν)+∑ν=rc𝔼⁡\[∑i=1r−wn𝖰⁡(Uiν)∣Uνν>𝖥⁡(p)\]𝔼⁡\[𝖰⁡(U)∣U≥𝖥⁡(p)\]⋅ℙ⁡(wc=ν)\],\\mathbb{E}\\bigl\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\mid p\\geq b^{\\textsc{n}}\_{\\scriptscriptstyle k+1},\\overline{\\mathsf{B}^{\\textsc{n}}\_{\\scriptscriptstyle k}}\\bigr\]=\\mathbb{E}\\bigl\[\\mathsf{Q}(U)\\bigm\|U\\geq\\mathsf{F}(p)\\bigr\]\\times\\\<br>\\textstyle\\mathbb{E}\\Bigl\[w\_{\\textsc{n}}+\\sum\_{\\scriptscriptstyle\\nu=1}^{\\scriptscriptstyle r-w\_{\\textsc{n}}-1}\\nu\\cdot\\mathbb{P}(w\_{\\textsc{c}}=\\nu)+\\sum\_{\\scriptscriptstyle\\nu=r}^{\\scriptscriptstyle c}\\tfrac{\\mathbb{E}\[\\sum\_{i=1}^{\\scriptscriptstyle r-w\_{\\textsc{n}}}\\mathsf{Q}(U\_{i}^{\\nu})\\mid U^{\\nu}\_{\\nu}>\\mathsf{F}(p)\]}{\\mathbb{E}\[\\mathsf{Q}(U)\\mid U\\geq\\mathsf{F}(p)\]}\\cdot\\mathbb{P}(w\_{\\textsc{c}}=\\nu)\\Bigr\], |  | (2) |

where U∼Uniform⁡\[0,1\]\\textstyle U\\sim\\mathrm{Uniform}\[0,1\], wn∼Binom⁡(k,1−𝖥⁡(p)1−𝖥⁡(bk+1n))w\_{\\textsc{n}}\\sim\\mathrm{Binom}(k,\\tfrac{1-\\mathsf{F}(p)}{1-\\mathsf{F}(b^{\\textsc{n}}\_{k+1})}) and wc∼Binom⁡(c,1−𝖥⁡(p))w\_{\\textsc{c}}\\sim\\mathrm{Binom}(c,1-\\mathsf{F}(p)).

C-PoP has an interesting connection to VCG when there are no colluding bidders:

###### Proposition 4.6.

Suppose Assumption [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmassumption1 "Assumption 4.1. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") holds, and we set M(pk,𝖡kn¯)=𝔼\[𝚆𝚎𝚕C-PoP(𝖭,𝖢;p)∣p≥bk+1n,𝖡kn¯\]M(p\_{k},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}})=\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\mid p\\geq b^{\\textsc{n}}\_{\\scriptscriptstyle k+1},\\overline{\\mathsf{B}^{\\textsc{n}}\_{\\scriptscriptstyle k}}\]. If there are no colluders, then C-PoP is equivalent to VCG on the non-colluders 𝖭\\mathsf{N}.

In the next theorem, we derive welfare guarantees for C-PoP and V-PoP:

###### Theorem 4.7(Expected Welfare Optimization).

If Assumption [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmassumption1 "Assumption 4.1. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") holds, and we set M(pk,𝖡kn¯)=𝔼\[𝚆𝚎𝚕C-PoP(𝖭,𝖢;p)∣p≥bk+1n,𝖡kn¯\]M(p\_{k},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}})=\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\mid p\\geq b^{\\textsc{n}}\_{\\scriptscriptstyle k+1},\\overline{\\mathsf{B}^{\\textsc{n}}\_{\\scriptscriptstyle k}}\], then C-PoP and V-PoP guarantee

|     |     |     |     |
| --- | --- | --- | --- |
|  | 𝔼⁡\[𝚆𝚎𝚕C-PoP​(𝖭,𝖢,p∗)\]≥𝔼⁡\[𝚆𝚎𝚕V-PoP​(𝖭,𝖢,p∗)\]≥𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭,∅)\].\\mathbb{E}\\bigl\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p^{\*})\\bigr\]\\geq\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{V-PoP}}(\\mathsf{N},\\mathsf{C};p^{\*})\]\\geq\\mathbb{E}\\bigl\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N},\\emptyset)\\bigr\]. |  | (3) |

As the number of non-colluders grows large, C-PoP’s performance converges to that of VCG where no bidders collude, showing that our mechanism asymptotically closes the welfare gap due to collusion.

###### Corollary 4.8.

When number of items rr is fixed and 𝖥⁡(⋅)\\mathsf{F}(\\cdot) has a bounded support, then we have that limn→∞𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭∪𝖢,∅)\]−𝔼⁡\[𝚆𝚎𝚕C-PoP​(𝖭,𝖢,p∗)\]=0\\textstyle\\lim\_{n\\to\\infty}\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N}\\cup\\mathsf{C},\\emptyset)\]-\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p^{\*})\]=0.

### 4.4 Expected Welfare Optimization for Partially-Known Bid Distribution

In some instances, 𝖥⁡(⋅)\\mathsf{F}(\\cdot) and 𝖰⁡(⋅)\\mathsf{Q}(\\cdot) may only be partially known. We can still use our C-PoP mechanism using a minorant of the expected welfare and optimize that using the following assumption:

###### Assumption 4.2.

Suppose the auctioneer knows value L>0L>0 such that L​x≤𝖰⁡(x)Lx\\leq\\mathsf{Q}(x) for all x∈\[0,1\]x\\in\[0,1\].

The above assumption is satisfied by many distributions. For example, distributions with bounded support starting from a nonnegative value and bounded from above as f⁡(V)≤1Lf(V)\\leq\\frac{1}{L} for all VV, where f⁡(⋅)f(\\cdot) is the probability density function, satisfy it. Using Assumption [4.2](https://arxiv.org/html/2511.12456v4#S4.Thmassumption2 "Assumption 4.2. ‣ 4.4 Expected Welfare Optimization for Partially-Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), we can construct minorants for 𝔼​\[𝚆𝚎𝚕C-PoP​(𝖭,𝖢,p)\]\\mathbb{E}\\left\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\right\], the details of which are deferred to Appendix [B.8](https://arxiv.org/html/2511.12456v4#A2.SS8 "B.8 Construction of Minorants for (Conditional) Expected Welfare ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information")

## 5 Numerical Experiments

Algorithm 3 Bid Manipulation in C-PoP with Misclassification

1:Input: Total number of items rr; 𝖭f\\mathsf{N}\_{\\textsc{f}}, 𝖭t\\mathsf{N}\_{\\textsc{t}}, 𝖢f\\mathsf{C}\_{\\textsc{f}}, 𝖢t\\mathsf{C}\_{\\textsc{t}} with bids b𝖭fb^{\\mathsf{N}\_{\\textsc{f}}}, b𝖭tb^{\\mathsf{N}\_{\\textsc{t}}}, b𝖢fb^{\\mathsf{C}\_{\\textsc{f}}}, b𝖢tb^{\\mathsf{C}\_{\\textsc{t}}}. Note that 𝖭t∪𝖢f\\mathsf{N}\_{\\textsc{t}}\\cup\\mathsf{C}\_{\\textsc{f}} are classified as non-colluders and 𝖭f∪𝖢t\\mathsf{N}\_{\\textsc{f}}\\cup\\mathsf{C}\_{\\textsc{t}} are classified as colluders.

2:Output: Manipulated bids b𝖢f,manipb^{\\mathsf{C}\_{\\textsc{f}},\\text{manip}}, b𝖢t,manipb^{\\mathsf{C}\_{\\textsc{t}},\\text{manip}}.

3:foric∈{0,1,⋯,\|𝖢f\|}i\_{c}\\in\\{0,1,\\cdots,\|\\mathsf{C}\_{\\textsc{f}}\|\\}do

4:b𝖢f,manip←b^{\\mathsf{C}\_{\\textsc{f}},\\text{manip}}\\leftarrow Set the bottommost ici\_{c} bids in b𝖢fb^{\\mathsf{C}\_{\\textsc{f}}} to 00.

5:


Run C-PoP using (b𝖢f,manip∪b𝖭t)(b^{\\mathsf{C}\_{\\textsc{f}},\\text{manip}}\\cup b^{\\mathsf{N}\_{\\textsc{t}}}) to find optimal p∗p^{\*}.

6:b𝖢t,manip←b^{\\mathsf{C}\_{\\textsc{t}},\\text{manip}}\\leftarrow Given p∗p^{\*} and using b𝖭fb^{\\mathsf{N}\_{\\textsc{f}}} and b𝖢tb^{\\mathsf{C}\_{\\textsc{t}}}, calculate overbidding strategy for bids b𝖢tb^{\\mathsf{C}\_{\\textsc{t}}}. An overbidding strategy consists of a decision variable qc≤\|𝖢T\|q\_{c}\\leq\|\\mathsf{C}\_{\\textsc{T}}\| for how many correctly classified colluders to bid above p∗p^{\*} to maximize expected welfare.

7:uc​(ic,b𝖢,manip):=𝔼⁡\[∑i∈Cxi​(vi−p)\]←u\_{\\textsc{c}}(i\_{\\textsc{c}},b^{\\mathsf{C},\\text{manip}}):=\\mathbb{E}\[\\sum\_{i\\in C}x\_{i}(v\_{i}-p)\]\\leftarrow Run C-PoP auction to allocate items and calculate the sum of colluders’ surpluses.

8:endfor

9:ic∗←arg⁡maxi\_{c}^{\*}\\leftarrow\\arg\\maxuc​(ic,b𝖢,manip)u\_{\\textsc{c}}(i\_{\\textsc{c}},b^{\\mathsf{C},\\text{manip}})

10:


Choose the corresponding b𝖢𝖳,manip,b𝖢𝖥,manipb^{\\mathsf{C\_{T}},\\text{manip}},b^{\\mathsf{C\_{F}},\\text{manip}}

In this section, we conduct numerical experiments to compare the peformance of C-PoP with the DP oracle, using classifiers of varying levels of sophistication, to two benchmark auction mechanisms:

1. 1.


VCG with Collusive Bid-Shading (VCG w/ Collusion): We conduct a VCG auction where the non-colluders bid truthfully, but the colluders strategically bid shade as per Lemma [A.1](https://arxiv.org/html/2511.12456v4#A1.Thmtheorem1 "Lemma A.1. ‣ A.1 Lemma on Bidding in VCG with Collusion ‣ Appendix A Appendix: VCG with Collusion ‣ Collusion-Proof Auction Design using Side Information").

2. 2.


Posted Price with Collusive Overbidding (PP w/ Collusion): We conduct a posted price auction where price is optimized assuming all bidders are truthful, and where items are randomly allocated to qualifiers. This random allocation allows colluders to overbid and manipulate the allocation.


We develop a firm size model to endogenize the sets of colluders and noncolluders, respectively. We assume that each bidder can be considered a firm with an attribute we call size SiS\_{i} that is independent of their valuation. Larger firms have a higher capacity to collude, and therefore their probability of colluding increases with their size. Each bidder’s size is randomly sampled from some distribution 𝒮\\mathcal{S}. The bidder’s size is then mapped via a sigmoid function σ⁡(Si)\\sigma(S\_{i}) which corresponds to the probability that the bidder is a colluder. A Uniform⁡\[0,1\]\\mathrm{Uniform}\[0,1\] random variable is simulated, and if it less than σ⁡(Si)\\sigma(S\_{i}) then bidder ii is a colluder, otherwise they are a noncolluder. We define ℓ⁡(Si)≤σ⁡(Si)\\ell(S\_{i})\\leq\\sigma(S\_{i}), which lower bounds the probability a bidder is a colluder as a function of its size. We sample from the size distribution 𝒮\\mathcal{S} and the valuation distribution a total of TT times to construct our sets of colluding and noncolluding bidders, where TT is the total number of bidders. We specify σ\\sigma and ℓ\\ell in the appendix.

![Refer to caption](https://arxiv.org/html/2511.12456v4/figures/T_sweep_r=10_alpha=5_beta=3_E_W.png)(a)Welfare (Exponential)

![Refer to caption](https://arxiv.org/html/2511.12456v4/figures/T_sweep_r=10_alpha=5_beta=3_E_R.png)(b)Revenue (Exponential)

![Refer to caption](https://arxiv.org/html/2511.12456v4/figures/T_sweep_r=10_alpha=5_beta=3_U_W.png)(c)Welfare (Uniform)

![Refer to caption](https://arxiv.org/html/2511.12456v4/figures/T_sweep_r=10_alpha=5_beta=3_U_R.png)(d)Revenue (Uniform)

Figure 1: Numerical results for Uniform(0,1) and Exponential (λ=2\\lambda=2) valuation distributions where r=10r=10. The solid orange curve is Posted Price with collusion, the dotted light blue curve is VCG with collusion, the long dash-dotted red curve is C-PoP with the firm specific classifier, the medium dash-dotted green curve is C-PoP with the 50/50 classifier, the short dash-dotted blue curve is C-PoP with the random classifier, and the dashed black curve is C-PoP with perfect classification.

We evaluate the misclassification robustness of C-PoP with the DP oracle by using classifiers of varying sophistication. Ranked in order of best-to-worst collusion detection, we consider:

1. 1.


C-PoP with Perfect Classification (C-PoP – Perfect): By Theorem [4.7](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem7 "Theorem 4.7 (Expected Welfare Optimization). ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), all bidders bid truthfully when there is no misclassification of the bidders.

2. 2.


C-PoP with Firm Specific Classification (C-PoP – Firm Specific): Bidder ii is classified as a colluder with probability ℓ⁡(Si)\\ell(S\_{i}). The condition ℓ⁡(Si)≤σ⁡(Si)\\ell(S\_{i})\\leq\\sigma(S\_{i}) ensures bidders are conservatively (i.e., reducing false positives) labeled as colluders.

3. 3.


C-PoP with Random Classification (C-PoP – Random): Bidder ii is classified as a colluder with probability equal to the percent of colluders in the auction.

4. 4.


C-PoP with 50/50 Classification (C-PoP – 50/50): Bidder ii is independently classified as a colluder with a 50% chance.


Classification levels 2–4 represent scenarios where the misclassification of colluders as non-colluders (and of non-colluders as colluders) means that the colluders may find it advantageous to manipulate their bids. We assume that colluders manipulate their bids in the manner described in Algorithm [3](https://arxiv.org/html/2511.12456v4#alg3 "Algorithm 3 ‣ 5 Numerical Experiments ‣ Collusion-Proof Auction Design using Side Information"):

We test C-PoP against the baseline mechanisms with r=10r=10 and 1515 items and a total number of bidders from T=20,30,…,110T=20,30,...,110. We experiment with a firm-size distribution 𝒮∼B​e​t​a​(5,3)\\mathcal{S}\\sim Beta(5,3). All simulations are over 1,000 repetitions, with tables of results and standard errors in the Appendix. Figure [1](https://arxiv.org/html/2511.12456v4#S5.F1 "Figure 1 ‣ 5 Numerical Experiments ‣ Collusion-Proof Auction Design using Side Information") visualizes the results, and it shows that C-PoP achieves high welfare and revenue relative to the benchmark auction mechanisms. Additionally, C-PoP is robust to collusion detection, as classifiers of different levels of sophistication do not substantially affect average welfare and revenue.

## 6 Conclusion

Common auction mechanisms are vulnerable to bidder collusion, which can reduce the auctioneer’s revenue or the welfare of non-colluders. To design truthful mechanisms resilient to collusion, this paper considers a novel approach that uses a machine learning classifier to predict which bidders are colluding. Using these predicted labels, the Conditional Posted Price (C-PoP) mechanism uses a two-phase oracle designed via dynamic programming to set a price, then conducts a posted price auction with the identified non-colluders, and concludes by conducting a posted price auction with the identified colluders using any remaining items. By carefully setting price by sequentially revealing increasingly-larger non-colluder bids, C-PoP achieves truthfulness (even in the presence of bidder collusion) and generates guarantees on expected welfare and auction price. Numerical experiments show that C-PoP can substantially outperform VCG under collusion and Posted Price under collusion, even when the classifier used by C-PoP to detect collusion is imperfect. An important direction for future work is to extend these results to auctions with heterogeneous items and online settings.

## References

- Agrawal et al. (2024)P. Agrawal, E. Balkanski, V. Gkatzelis, T. Ou, and X. TanLearning-augmented mechanism design: leveraging predictions for facility location.
Mathematics of Operations Research49 (4), pp. 2626–2651 (en).
External Links: ISSN 0364-765X, 1526-5471Cited by: [§1.1](https://arxiv.org/html/2511.12456v4#S1.SS1.p1.1 "1.1 Mechanism Design with Side Information ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Assad et al. (2024)S. Assad, R. Clark, D. Ershov, and L. XuAlgorithmic pricing and competition: empirical evidence from the german retail gasoline market.
Journal of Political Economy132 (3), pp. 723–771 (en).
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Balcan et al. (2023)M. Balcan, S. Prasad, and T. SandholmBicriteria multidimensional mechanism design with side information.
In Proceedings of the 37th International Conference on Neural Information Processing Systems,
NIPS ’23.
Cited by: [§1.1](https://arxiv.org/html/2511.12456v4#S1.SS1.p1.1 "1.1 Mechanism Design with Side Information ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Balkanski et al. (2023)E. Balkanski, V. Gkatzelis, and X. TanStrategyproof scheduling with predictions.
14th Innovations in Theoretical Computer Science Conference (ITCS)251.
Cited by: [§1.1](https://arxiv.org/html/2511.12456v4#S1.SS1.p1.1 "1.1 Mechanism Design with Side Information ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Basu and Mukherjee (2024)R. Basu and C. MukherjeeStrategy-proof multidimensional mechanism design.
Mathematics of Operations Research49 (4), pp. 2768–2785 (en).
Cited by: [§1.2](https://arxiv.org/html/2511.12456v4#S1.SS2.p1.1 "1.2 Collusion-Resistant Mechanisms ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Blumrosen and Holenstein (2008)L. Blumrosen and T. HolensteinPosted prices vs. negotiations: an asymptotic analysis..
EC10, pp. 1386790–1386801.
Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Bonjour et al. (2022)T. Bonjour, V. Aggarwal, and B. BhargavaInformation theoretic approach to detect collusion in multi-agent games.
In Proceedings of the Thirty-Eighth Conference on Uncertainty in Artificial Intelligence,
Proceedings of Machine Learning Research, Vol. 180, pp. 223–232.
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Bulow and Klemperer (1996)J. Bulow and P. KlempererAuctions versus negotiations.
American Economic Review86 (1), pp. 180–94.
Cited by: [§1.4](https://arxiv.org/html/2511.12456v4#S1.SS4.p1.1 "1.4 Contributions and Outline ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information"),
[§3](https://arxiv.org/html/2511.12456v4#S3.p4.1 "3 Performance of VCG with Collusion ‣ Collusion-Proof Auction Design using Side Information").

- Calvano et al. (2018)E. Calvano, G. Calzolari, V. Denicolo, and S. PastorelloArtificial intelligence, algorithmic pricing and collusion.
SSRN Electronic Journal (en).
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Chassang et al. (2022)S. Chassang, K. Kawai, J. Nakabayashi, and J. OrtnerRobust screens for noncompetitive bidding in procurement auctions.
Econometrica90 (1), pp. 315–346 (en).
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Cheng et al. (2013)Y. Cheng, W. Yu, and G. ZhangStrategy-proof approximation mechanisms for an obnoxious facility game on networks.
Theoretical Computer Science497, pp. 154–163.
Cited by: [§1.2](https://arxiv.org/html/2511.12456v4#S1.SS2.p1.1 "1.2 Collusion-Resistant Mechanisms ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Conley and Decarolis (2016)T. G. Conley and F. DecarolisDetecting bidders groups in collusive auctions.
American Economic Journal: Microeconomics8 (2), pp. 1–38 (en).
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- David and Nagaraja (2003)H. A. David and H. N. NagarajaOrder statistics.
1 edition, Wiley Series in Probability and Statistics, Wiley (en).
External Links: ISBN 9780471389262 9780471722168Cited by: [§B.5](https://arxiv.org/html/2511.12456v4#A2.SS5.p1.1 "B.5 Proof of Proposition ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information"),
[§B.8](https://arxiv.org/html/2511.12456v4#A2.SS8.p2.1.1 "Proof. ‣ B.8 Construction of Minorants for (Conditional) Expected Welfare ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information").

- Devanur et al. (2016)N. R. Devanur, Z. Huang, and C. PsomasThe sample complexity of auctions with side information.
In Proceedings of the Forty-Eighth Annual ACM Symposium on Theory of Computing,
STOC ’16, pp. 426–439.
Cited by: [§1.1](https://arxiv.org/html/2511.12456v4#S1.SS1.p1.1 "1.1 Mechanism Design with Side Information ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Dhangwatnotai et al. (2015)P. Dhangwatnotai, T. Roughgarden, and Q. YanRevenue maximization with a single sample.
Games and Economic Behavior91, pp. 318–333.
Cited by: [§4](https://arxiv.org/html/2511.12456v4#S4.p2.1 "4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information").

- Friedman (1964)M. FriedmanComment on" collusion in the auction market for treasury bills".
Journal of Political Economy72 (5), pp. 513–514.
Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- García Rodríguez et al. (2022)M. J. García Rodríguez, V. Rodríguez-Montequín, P. Ballesteros-Pérez, P. E.D. Love, and R. SignorCollusion detection in public procurement auctions with machine learning algorithms.
Automation in Construction133, pp. 104047 (en).
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Goldberg and Hartline (2004)A. Goldberg and J. HartlineCollusion-resistant mechanisms for single-parameter agents.
In Proc. 16th Symp. on Discrete Alg.,
Proc. 16th Symp. on Discrete Alg. edition, pp. 15.
Cited by: [§1.2](https://arxiv.org/html/2511.12456v4#S1.SS2.p1.1 "1.2 Collusion-Resistant Mechanisms ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information"),
[§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Goldberg et al. (2006)A. V. Goldberg, J. D. Hartline, A. R. Karlin, M. Saks, and A. WrightCompetitive auctions.
Games and Economic Behavior55 (2), pp. 242–269.
Cited by: [§4](https://arxiv.org/html/2511.12456v4#S4.p2.1 "4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information").

- Goswami et al. (1996)G. Goswami, T. H. Noe, and M. J. RebelloCollusion in uniform-price auctions: experimental evidence and implications for treasury auctions.
The Review of Financial Studies9 (3), pp. 757–785.
Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Groves (1973)T. GrovesIncentives in teams.
Econometrica41 (4), pp. 617.
Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Hartline et al. (2024)J. D. Hartline, S. Long, and C. ZhangRegulation of algorithmic collusion.
In Proceedings of the Symposium on Computer Science and Law,
pp. 98–108 (en).
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Hendricks and Porter (1989)K. Hendricks and R. H. PorterCollusion in auctions.
Annales d’Economie et de Statistique, pp. 217–230.
Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Hespanhol and Aswani (2020)P. Hespanhol and A. AswaniHypothesis testing approach to detecting collusion in competitive environments.
In Proceedings of the 13th EAI International Conference on Performance Evaluation Methodologies and Tools,
pp. 35–40.
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Juarez (2013)R. JuarezGroup strategyproof cost sharing: the role of indifferences.
Games and Economic Behavior82, pp. 218–239 (en).
Cited by: [§1.2](https://arxiv.org/html/2511.12456v4#S1.SS2.p1.1 "1.2 Collusion-Resistant Mechanisms ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Kayı and Ramaekers (2010)Ç. Kayı and E. RamaekersCharacterizations of pareto-efficient, fair, and strategy-proof allocation rules in queueing problems.
Games and Economic Behavior68 (1), pp. 220–232 (en).
Cited by: [§1.2](https://arxiv.org/html/2511.12456v4#S1.SS2.p1.1 "1.2 Collusion-Resistant Mechanisms ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Kertz (1986)R. P. KertzStop rule and supremum expectations of i.i.d. random variables: a complete comparison by conjugate duality.
Journal of Multivariate Analysis19 (1), pp. 88–112.
External Links: [Document](https://dx.doi.org/10.1016/0047-259X%2886%2990106-7 "")Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Krishna and Perry (1997)V. Krishna and M. PerryEfficient mechanism design.
SSRN Electronic Journal (en).
Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Lyra et al. (2022)M. S. Lyra, B. Damásio, F. L. Pinheiro, and F. BacaoFraud, corruption, and collusion in public procurement activities, a systematic literature review on data-driven methods.
Applied Network Science7 (1), pp. 83 (en).
Cited by: [§1.3](https://arxiv.org/html/2511.12456v4#S1.SS3.p1.1 "1.3 Collusion Detection via Machine Learning ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Mitra and Mutuswami (2011)M. Mitra and S. MutuswamiGroup strategyproofness in queueing models.
Games and Economic Behavior72 (1), pp. 242–254.
Cited by: [§1.2](https://arxiv.org/html/2511.12456v4#S1.SS2.p1.1 "1.2 Collusion-Resistant Mechanisms ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Pal and Tardos (2003)M. Pal and E. TardosGroup strategy proof mechanisms via primal-dual algorithms.
In 44th Annual IEEE Symposium on Foundations of Computer Science, 2003. Proceedings.,
pp. 584–593.
Cited by: [§1.2](https://arxiv.org/html/2511.12456v4#S1.SS2.p1.1 "1.2 Collusion-Resistant Mechanisms ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Robinson (1985)M. S. RobinsonCollusion and the choice of auction.
The RAND Journal of Economics16 (1), pp. 141.
Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Sher (2012)I. SherOptimal shill bidding in the VCG mechanism.
Economic Theory50 (2), pp. 341–387 (en).
External Links: ISSN 1432-0479Cited by: [§3](https://arxiv.org/html/2511.12456v4#S3.p2.1 "3 Performance of VCG with Collusion ‣ Collusion-Proof Auction Design using Side Information").

- Tang et al. (2020a)P. Tang, D. Yu, and S. ZhaoCharacterization of Group-strategyproof Mechanisms for Facility Location in Strictly Convex Space.
In Proceedings of the 21st ACM Conference on Economics and Computation,
Virtual Event Hungary, pp. 133–157 (en).
External Links: ISBN 9781450379755Cited by: [§1.1](https://arxiv.org/html/2511.12456v4#S1.SS1.p1.1 "1.1 Mechanism Design with Side Information ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Tang et al. (2020b)P. Tang, D. Yu, and S. ZhaoCharacterization of group-strategyproof mechanisms for facility location in strictly convex space.
In Proceedings of the 21st ACM Conference on Economics and Computation,
pp. 133–157 (en).
Cited by: [§1.2](https://arxiv.org/html/2511.12456v4#S1.SS2.p1.1 "1.2 Collusion-Resistant Mechanisms ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Vickrey (1961)W. VickreyCounterspeculation, auctions, and competitive sealed tenders.
The Journal of Finance16 (1), pp. 8–37 (en).
Cited by: [§1](https://arxiv.org/html/2511.12456v4#S1.p1.1 "1 Introduction ‣ Collusion-Proof Auction Design using Side Information").

- Xu and Lu (2022)C. Xu and P. LuMechanism design with predictions.
In Proceedings of the Thirty-First International Joint Conference on Artificial Intelligence,
Vienna, Austria, pp. 571–577.
Cited by: [§1.1](https://arxiv.org/html/2511.12456v4#S1.SS1.p1.1 "1.1 Mechanism Design with Side Information ‣ 1 Introduction ‣ Collusion-Proof Auction Design using Side Information").


## Appendix A Appendix: VCG with Collusion

### A.1 Lemma on Bidding in VCG with Collusion

###### Lemma A.1.

Consider the VCG mechanism. Let rcr\_{\\textsc{c}} be the number of items colluders win, and let rn=r−rcr\_{\\textsc{n}}=r-r\_{\\textsc{c}} be the number of items non-colluders win. It is optimal for non-colluders to bid truthfully 𝐛n=𝐯n\\mathbf{b}^{\\textsc{n}}=\\mathbf{v}^{\\textsc{n}}. It is optimal for colluders to bid bic=max⁡{vic,brn+1n+ϵ}b^{\\textsc{c}}\_{i}=\\max\\{v^{\\textsc{c}}\_{i},b^{\\textsc{n}}\_{r\_{\\textsc{n}}+1}+\\epsilon\\} for i∈{1,⋯,rc}i\\in\\{1,\\cdots,r\_{\\textsc{c}}\\} and bic=0b^{\\textsc{c}}\_{i}=0 for i∈{rc+1,⋯,C}i\\in\\{r\_{\\textsc{c}}+1,\\cdots,C\\}, for any small ϵ>0\\epsilon>0, where brn+1nb^{\\textsc{n}}\_{r\_{\\textsc{n}}+1} is the largest losing bid among non-colluding bidders. With this optimal bidding strategy, the colluders achieve a utility of

|     |     |     |     |
| --- | --- | --- | --- |
|  | uc​(𝐯n,rc):=max𝐛c⁡{uc​(𝐛c,𝐯n)∣∑i∈cxi​(𝐛c,𝐯n)=rc}=∑i=1rcvic−rc⋅brn+1n.\\textstyle u\_{\\textsc{c}}(\\mathbf{v}^{\\textsc{n}};r\_{\\textsc{c}}):=\\max\_{\\mathbf{b}^{\\textsc{c}}}\\left\\{u\_{\\textsc{c}}\\left(\\mathbf{b}^{\\textsc{c}},\\mathbf{v}^{\\textsc{n}}\\right)\\mid\\sum\_{i\\in\\textsc{c}}x\_{i}(\\mathbf{b}^{\\textsc{c}},\\mathbf{v}^{\\textsc{n}})=r\_{\\textsc{c}}\\right\\}=\\sum\_{i=1}^{r\_{\\textsc{c}}}v^{\\textsc{c}}\_{i}-r\_{\\textsc{c}}\\cdot b^{\\textsc{n}}\_{r\_{\\textsc{n}}+1}. |  | (4) |

Let rc∗r\_{\\textsc{c}}^{\*} and rn∗r\_{\\textsc{n}}^{\*} be the VCG allocation to colluding and non-colluding bidders, respectively, in the absence of collusion. Even when manipulating their bids, the colluding bidders do not desire more than rc∗r\_{\\textsc{c}}^{\*} items,that meaning that uc​(𝐯n,rc∗)≥uc​(𝐯n,rc∗+Δ​r)u\_{\\textsc{c}}(\\mathbf{v}^{\\textsc{n}};r\_{\\textsc{c}}^{\*})\\geq u\_{\\textsc{c}}(\\mathbf{v}^{\\textsc{n}};r\_{\\textsc{c}}^{\*}+\\Delta r) for all Δ​r>0\\Delta r>0.

###### Proof.

Since the VCG mechanism is DSIC and since non-colluding bidders maximize only their own utility, their bids 𝐛n\\mathbf{b}^{\\textsc{n}} must be their true valuations 𝐯n\\mathbf{v}^{\\textsc{n}}. The colluders maximize uc​(bc,vn)=∑i∈cvi​xi−piu\_{\\textsc{c}}(b^{\\textsc{c}},v^{\\textsc{n}})=\\sum\_{i\\in\\textsc{c}}v\_{i}x\_{i}-p\_{i}. For ∑i∈cxi=rc\\sum\_{i\\in\\textsc{c}}x\_{i}=r\_{\\textsc{c}}, the rcr\_{\\textsc{c}} largest colluder bids win. The VCG payment pip\_{i} is max⁡{brc+1c,brn+1n}\\max\\{b^{\\textsc{c}}\_{r\_{\\textsc{c}}+1},b^{\\textsc{n}}\_{r\_{\\textsc{n}}+1}\\}. The choice bic=0b^{\\textsc{c}}\_{i}=0 for i∈{rc+1,…,C}i\\in\\{r\_{\\textsc{c}}+1,\\dots,C\\} minimizes the payment since brc+1c=0b^{\\textsc{c}}\_{r\_{\\textsc{c}}+1}=0. The winning bids bic=max⁡{vic,brn+1n+ϵ}b^{\\textsc{c}}\_{i}=\\max\\{v^{\\textsc{c}}\_{i},b^{\\textsc{n}}\_{r\_{\\textsc{n}}+1}+\\epsilon\\} for i∈{1,…,rc}i\\in\\{1,\\dots,r\_{\\textsc{c}}\\} ensure allocation and bic>brn+1nb^{\\textsc{c}}\_{i}>b^{\\textsc{n}}\_{r\_{\\textsc{n}}+1} for small ϵ>0\\epsilon>0. Since payment pi=brn+1np\_{i}=b^{\\textsc{n}}\_{r\_{\\textsc{n}}+1}, the maximum utility for fixed rcr\_{\\textsc{c}} is uc​(bc,vn)=∑i=1rcvic−rc⋅brn+1nu\_{\\textsc{c}}(b^{\\textsc{c}},v^{\\textsc{n}})=\\sum\_{i=1}^{r\_{\\textsc{c}}}v^{\\textsc{c}}\_{i}-r\_{\\textsc{c}}\\cdot b^{\\textsc{n}}\_{r\_{\\textsc{n}}+1}. The welfare-maximizing allocation is (rc∗,rn∗)(r\_{\\textsc{c}}^{\*},r\_{\\textsc{n}}^{\*}). For any Δ​r>0\\Delta r>0, we have that

|     |     |     |     |     |
| --- | --- | --- | --- | --- |
|  | uc​(vn,rc∗+Δ​r)−uc​(vn,rc∗)\\displaystyle\\textstyle u\_{\\textsc{c}}(v^{\\textsc{n}};r\_{\\textsc{c}}^{\*}+\\Delta r)-u\_{\\textsc{c}}(v^{\\textsc{n}};r\_{\\textsc{c}}^{\*}) | =∑i=rc∗+1rc∗+Δ​rvic−(rc∗+Δ​r)​brn∗−Δ​r+1n+rc∗​brn∗+1n\\displaystyle=\\textstyle\\sum\_{i=r\_{\\textsc{c}}^{\*}+1}^{r\_{\\textsc{c}}^{\*}+\\Delta r}v^{\\textsc{c}}\_{i}-\\left(r\_{\\textsc{c}}^{\*}+\\Delta r\\right)b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}-\\Delta r+1}+r\_{\\textsc{c}}^{\*}b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}+1} |  | (5) |
|  |  | =∑i=1Δ​r(vrc∗+ic−brn∗−Δ​r+1n)+rc∗​(brn∗+1n−brn∗−Δ​r+1n)\\displaystyle\\textstyle\\displaystyle=\\sum\_{i=1}^{\\Delta r}\\bigl(v^{\\textsc{c}}\_{r\_{\\textsc{c}}^{\*}+i}-b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}-\\Delta r+1}\\bigr)+r\_{\\textsc{c}}^{\*}\\bigl(b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}+1}-b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}-\\Delta r+1}\\bigr) |  |
|  |  | ≤0.\\displaystyle\\textstyle\\displaystyle\\leq 0. |  |

This holds because: (1) vrc∗+ic≤brn∗nv^{\\textsc{c}}\_{r\_{\\textsc{c}}^{\*}+i}\\leq b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}} for i≥1i\\geq 1, as these are items the colluders did not win in the truthful VCG allocation, and brn∗−Δ​r+1n≥brn∗nb^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}-\\Delta r+1}\\geq b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}}; thus vrc∗+ic≤brn∗−Δ​r+1nv^{\\textsc{c}}\_{r\_{\\textsc{c}}^{\*}+i}\\leq b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}-\\Delta r+1}. (2) bnb^{\\textsc{n}} is sorted in descending order, and brn∗+1n≤brn∗−Δ​r+1nb^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}+1}\\leq b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}-\\Delta r+1} since Δ​r>0\\Delta r>0. Both parts of the sum are non-positive.
∎

### A.2 Proof of Proposition [3.1](https://arxiv.org/html/2511.12456v4\#S3.Thmtheorem1 "Proposition 3.1. ‣ 3 Performance of VCG with Collusion ‣ Collusion-Proof Auction Design using Side Information")

By Lemma [A.1](https://arxiv.org/html/2511.12456v4#A1.Thmtheorem1 "Lemma A.1. ‣ A.1 Lemma on Bidding in VCG with Collusion ‣ Appendix A Appendix: VCG with Collusion ‣ Collusion-Proof Auction Design using Side Information"), rcC​o​l≤rc∗r\_{\\textsc{c}}^{\\scriptscriptstyle Col}\\leq r\_{\\textsc{c}}^{\*}. Hence, rnC​o​l≥rn∗r\_{\\textsc{n}}^{\\scriptscriptstyle Col}\\geq r\_{\\textsc{n}}^{\*} and vic>brnC​o​l+1nv^{\\textsc{c}}\_{i}>b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\\scriptscriptstyle Col}+1} (the payment price for winning items). The optimal winning bids are bic,C​o​l=max⁡{vic,brnC​o​l+1n+ϵ}=vicb^{\\textsc{c},\\scriptscriptstyle Col}\_{i}=\\max\\{v^{\\textsc{c}}\_{i},b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\\scriptscriptstyle Col}+1}+\\epsilon\\}=v^{\\textsc{c}}\_{i} for i∈{1,…,rcC​o​l}i\\in\\{1,\\dots,r\_{\\textsc{c}}^{\\scriptscriptstyle Col}\\} and losing bids bic,C​o​l=0b^{\\textsc{c},\\scriptscriptstyle Col}\_{i}=0 for i∈{rcC​o​l+1,…,C}i\\in\\{r\_{\\textsc{c}}^{\\scriptscriptstyle Col}+1,\\dots,C\\}. That is, colluding bidders are incentivized to bid as low as possible to win, and always bid either vicv^{\\textsc{c}}\_{i} or 00 ensuring bic,C​o​l≤vicb^{\\textsc{c},\\scriptscriptstyle Col}\_{i}\\leq v^{\\textsc{c}}\_{i} (bid shading).

Since rnC​o​l≥rn∗r\_{\\textsc{n}}^{\\scriptscriptstyle Col}\\geq r\_{\\textsc{n}}^{\*}, the non-colluders’ allocation is non-decreasing: xi​(bC​o​l)≥xi​(b∗)x\_{i}(b^{\\scriptscriptstyle Col})\\geq x\_{i}(b^{\*}) for i∈ni\\in\\textsc{n}. The collusive payment is p⁡(bC​o​l)=brnC​o​l+1np(b^{\\scriptscriptstyle Col})=b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\\scriptscriptstyle Col}+1}, and truthful payment is p⁡(b∗)=max⁡{vrc∗+1c,brn∗+1n}p(b^{\*})=\\max\\{v^{\\textsc{c}}\_{r\_{\\textsc{c}}^{\*}+1},b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}+1}\\}. Since rnC​o​l≥rn∗r\_{\\textsc{n}}^{\\scriptscriptstyle Col}\\geq r\_{\\textsc{n}}^{\*}, brnC​o​l+1n≤brn∗+1nb^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\\scriptscriptstyle Col}+1}\\leq b^{\\textsc{n}}\_{r\_{\\textsc{n}}^{\*}+1}, so p⁡(bC​o​l)≤p⁡(b∗)p(b^{\\scriptscriptstyle Col})\\leq p(b^{\*}). We thus have ui​(bC​o​l)=xi​(bC​o​l)​vi−p⁡(bC​o​l)≥xi​(b∗)​vi−p⁡(b∗)=ui​(b∗)u\_{i}(b^{\\scriptscriptstyle Col})=x\_{i}(b^{\\scriptscriptstyle Col})v\_{i}-p(b^{\\scriptscriptstyle Col})\\geq x\_{i}(b^{\*})v\_{i}-p(b^{\*})=u\_{i}(b^{\*}) for the non-colluder utility, uc​(bC​o​l)=uc​(vn,rcC​o​l)≥uc​(vn,rc∗)=uc​(b∗)u\_{\\textsc{c}}(b^{\\scriptscriptstyle Col})=u\_{\\textsc{c}}(v^{\\textsc{n}};r^{\\scriptscriptstyle Col}\_{\\textsc{c}})\\geq u\_{\\textsc{c}}(v^{\\textsc{n}};r^{\*}\_{\\textsc{c}})=u\_{\\textsc{c}}(b^{\*}) by definition of rcC​o​lr^{\\scriptscriptstyle Col}\_{\\textsc{c}} for the colluder utility, and ua​(bC​o​l)=r⋅p⁡(bC​o​l)≤r⋅p⁡(b∗)=ua​(b∗)u\_{a}(b^{\\scriptscriptstyle Col})=r\\cdot p(b^{\\scriptscriptstyle Col})\\leq r\\cdot p(b^{\*})=u\_{a}(b^{\*}) for the auctioneer’s revenue.

VCG without collusion maximizes social welfare, 𝚆𝚎𝚕⁡(b∗)\\mathtt{Wel}(b^{\*}). Any deviation bC​o​lb^{\\scriptscriptstyle Col} that results in a different allocation must yield 𝚆𝚎𝚕⁡(bC​o​l)≤𝚆𝚎𝚕⁡(b∗)\\mathtt{Wel}(b^{\\scriptscriptstyle Col})\\leq\\mathtt{Wel}(b^{\*}). This, combined with 𝚁𝚎𝚟⁡(bC​o​l)≤𝚁𝚎𝚟⁡(b∗)\\mathtt{Rev}(b^{\\scriptscriptstyle Col})\\leq\\mathtt{Rev}(b^{\*}) (from the auctioneer’s utility), confirms that both welfare and revenue are non-increasing.

### A.3 Proof of Proposition [3.2](https://arxiv.org/html/2511.12456v4\#S3.Thmtheorem2 "Proposition 3.2. ‣ 3 Performance of VCG with Collusion ‣ Collusion-Proof Auction Design using Side Information")

First, we prove 𝚆𝚎𝚕VCG​(𝖭,𝖢)≥𝚆𝚎𝚕VCG​(𝖭,∅)\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N},\\mathsf{C})\\geq\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N},\\emptyset) and 𝚁𝚎𝚟VCG​(𝖭,𝖢)≥𝚁𝚎𝚟VCG​(𝖭,∅)\\mathtt{Rev}\_{\\textsc{VCG}}(\\mathsf{N},\\mathsf{C})\\geq\\mathtt{Rev}\_{\\textsc{VCG}}(\\mathsf{N},\\emptyset). From Lemma [3.1](https://arxiv.org/html/2511.12456v4#S3.Thmtheorem1 "Proposition 3.1. ‣ 3 Performance of VCG with Collusion ‣ Collusion-Proof Auction Design using Side Information"), when all 𝖭∪𝖢\\mathsf{N}\\cup\\mathsf{C} bidders participate in a VCG mechanism, the non-colluding bidders bid vnv^{\\textsc{n}} (i.e., truthfully) and the colluding bidders bid bc,C​o​l≤vcb^{\\textsc{c},\\scriptscriptstyle Col}\\leq v^{\\textsc{c}} (i.e., either bid shade to 0 or report their true valuation). The welfare achieved is 𝚆𝚎𝚕⁡(vn,bc,C​o​l)\\mathtt{Wel}(v^{\\textsc{n}},b^{\\textsc{c},\\scriptscriptstyle Col}). Since the VCG mechanism allocates items to the top bidders, when a colluding bidder ii bid shades to 00, an item could be allocated to a bidder jj who values it less than ii leading to a welfare loss. In the worst case, all the colluders bid shade to 00 achieving a welfare 𝚆𝚎𝚕⁡(vn,0)\\mathtt{Wel}(v^{\\textsc{n}},0). Hence, 𝚆𝚎𝚕⁡(vn,bc,C​o​l)≥𝚆𝚎𝚕⁡(vn,0)\\mathtt{Wel}(v^{\\textsc{n}},b^{\\textsc{c},\\scriptscriptstyle Col})\\geq\\mathtt{Wel}(v^{\\textsc{n}},0). Now, consider a VCG auction with only the non-colluding bidders 𝖭\\mathsf{N} achieving a welfare 𝚆𝚎𝚕⁡(vn)\\mathtt{Wel}(v^{\\textsc{n}}). Since the bidders have non-negative valuations, adding \|𝖢\|\|\\mathsf{C}\| more bids of 00 cannot hurt the welfare, that is 𝚆𝚎𝚕⁡(vn)≤𝚆𝚎𝚕⁡(vn,0)\\mathtt{Wel}(v^{\\textsc{n}})\\leq\\mathtt{Wel}(v^{\\textsc{n}},0). The result follows from 𝚆𝚎𝚕⁡(vn,bc,C​o​l)≥𝚆𝚎𝚕⁡(vn,0)≥𝚆𝚎𝚕⁡(vn)\\mathtt{Wel}(v^{\\textsc{n}},b^{\\textsc{c},\\scriptscriptstyle Col})\\geq\\mathtt{Wel}(v^{\\textsc{n}},0)\\geq\\mathtt{Wel}(v^{\\textsc{n}}). The proof for revenue is similar. When \|𝖭\|>r\|\\mathsf{N}\|>r, the price drops to vr+1nv^{\\textsc{n}}\_{r+1} in the worst case when all colluding bidders bid shade to 00, and the revenue 𝚁𝚎𝚟VCG​(𝖭,𝖢)≥vr+1n​r=𝚁𝚎𝚟VCG​(𝖭,∅)\\mathtt{Rev}\_{\\textsc{VCG}}(\\mathsf{N},\\mathsf{C})\\geq v^{\\textsc{n}}\_{r+1}r=\\mathtt{Rev}\_{\\textsc{VCG}}(\\mathsf{N},\\emptyset). When \|𝖭\|≤r\|\\mathsf{N}\|\\leq r, 𝚁𝚎𝚟VCG​(𝖭,∅)=0\\mathtt{Rev}\_{\\textsc{VCG}}(\\mathsf{N},\\emptyset)=0 and 𝚁𝚎𝚟VCG​(𝖭,𝖢)≥𝚁𝚎𝚟VCG​(𝖭,∅)\\mathtt{Rev}\_{\\textsc{VCG}}(\\mathsf{N},\\mathsf{C})\\geq\\mathtt{Rev}\_{\\textsc{VCG}}(\\mathsf{N},\\emptyset) holds trivially.

From the claim proved above, 𝚆𝚎𝚕VCG​(𝖭∪𝖭′,𝖢)≥𝚆𝚎𝚕VCG​(𝖭∪𝖭′,∅)\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N}\\cup\\mathsf{N}^{\\prime},\\mathsf{C})\\geq\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N}\\cup\\mathsf{N}^{\\prime},\\emptyset). Now suppose 𝖭c​o​l​l​u​d​e′\\mathsf{N}^{\\prime}\_{collude} are the bidders in 𝖭\\mathsf{N} who have decided to collude. Since VCG by construction achieves the highest possible welfare when no bidders collude, this means we must have 𝚆𝚎𝚕VCG​(𝖭∪𝖭′,∅)≥𝚆𝚎𝚕OPT​(𝖭∪𝖭c​o​l​l​u​d​e′)\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N}\\cup\\mathsf{N}^{\\prime},\\emptyset)\\geq\\mathtt{Wel}\_{\\textsc{OPT}}(\\mathsf{N}\\cup\\mathsf{N}^{\\prime}\_{collude}). Since the bidders are assumed to have true valuations from an i.i.d. distribution, 𝔼⁡\[𝚆𝚎𝚕OPT​(𝖭∪𝖭c​o​l​l​u​d​e′)\]=𝔼⁡\[𝚆𝚎𝚕OPT​(𝖭∪𝖢)\]\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{OPT}}(\\mathsf{N}\\cup\\mathsf{N}^{\\prime}\_{collude})\]=\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{OPT}}(\\mathsf{N}\\cup\\mathsf{C})\]. Putting this all together, we get 𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭∪𝖭′,𝖢)\]≥𝔼⁡\[𝚆𝚎𝚕OPT​(𝖭∪𝖢)\]\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N}\\cup\\mathsf{N}^{\\prime},\\mathsf{C})\]\\geq\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{OPT}}(\\mathsf{N}\\cup\\mathsf{C})\], which is the desired result.

## Appendix B Appendix: C-PoP Mechanism

### B.1 Alternative Approaches to the DP Oracle in Algorithm [2](https://arxiv.org/html/2511.12456v4\#alg2 "Algorithm 2 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information")

We present three other approaches for designing the oracle in Algorithm [2](https://arxiv.org/html/2511.12456v4#alg2 "Algorithm 2 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"): unconditional and conditional maximization-based approaches, and a greedy approach. In general, approaches that incorporate more observed non-colluding bids bnb^{\\textsc{n}} when computing the optimal (k∗,p∗)(k^{\*},p^{\*}) perform better, albeit at increased computational cost. In particular, dynamic programming performs best, followed by greedy, conditional, and unconditional maximization, in that order.

Algorithm 4 Oracle(bn,n,cb^{\\textsc{n}},n,c)

1:Input: Total number of items rr; number of non-colluding bidders and colluding bidders nn, cc respectively; non-colluding bids bnb^{\\textsc{n}}; function M⁡(p,𝖡kn¯)M(p,\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}).

2:Parameter: Approach ∈\\in {Unconditional Maximization, Conditional Maximization, Greedy}

3:Output:k∗,p∗k^{\*},p^{\*}

4:fork∈{0,⋯,r}k\\in\\{0,\\cdots,r\\}do

5:pk=arg⁡maxp≥bk+1n⁡M⁡(p,𝖡kn¯)p\_{k}=\\arg\\max\_{p\\geq b^{\\textsc{n}}\_{k+1}}M(p,\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}})

6:endfor

7:if Approach =⁣=== Unconditional Maximization then⊳\\trianglerightApproach 1

8:k∗←arg⁡maxk∈{0,⋯,r}⁡𝔼⁡\[M⁡(pk,ℬkn¯)\]k^{\*}\\leftarrow\\arg\\max\_{k\\in\\{0,\\cdots,r\\}}\\mathbb{E}\\left\[M(p\_{k},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k}})\\right\]

9:p∗←pk∗p^{\*}\\leftarrow p\_{k^{\*}}

10:endif

11:if Approach =⁣=== Conditional Maximization then⊳\\trianglerightApproach 2

12:k∗←arg⁡maxk∈{0,⋯,r}⁡𝔼⁡\[M⁡(pk,ℬkn¯)∣𝖡rn¯\]k^{\*}\\leftarrow\\arg\\max\_{k\\in\\{0,\\cdots,r\\}}\\mathbb{E}\\left\[M(p\_{k},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k}})\\mid\\overline{\\mathsf{B}^{\\textsc{n}}\_{r}}\\right\]

13:p∗←pk∗p^{\*}\\leftarrow p\_{k^{\*}}

14:endif

15:if Approach =⁣=== Greedy then⊳\\trianglerightApproach 3

16:


Set k∗←rk^{\*}\\leftarrow r

17:whileM⁡(pk∗,𝖡k∗n¯)<𝔼⁡\[M⁡(pk∗−1,ℬk∗−1n¯)∣𝖡k∗n¯\]M(p\_{k^{\*}},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k^{\*}}})<\\mathbb{E}\\left\[M(p\_{k^{\*}-1},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k^{\*}-1}})\\mid\\overline{\\mathsf{B}^{\\textsc{n}}\_{k^{\*}}}\\right\]do

18:k∗←k∗−1k^{\*}\\leftarrow k^{\*}-1

19:endwhile

20:p∗←pk∗p^{\*}\\leftarrow p\_{k^{\*}}

21:endif

### B.2 Proof of Theorem [4.3](https://arxiv.org/html/2511.12456v4\#S4.Thmtheorem3 "Theorem 4.3 (C-PoP Truthfulness). ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information")

#### Non-colluders.

Consider bidder i∈𝖭i\\in\\mathsf{N} and fix the bids from other bidders bi−b\_{i-}. First, we characterise how changes in the bidder ii’s reported bid affects the outcome of the DP oracle [2](https://arxiv.org/html/2511.12456v4#alg2 "Algorithm 2 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") in the next lemma.

###### Lemma B.1.

Fix i∈𝖭i\\in\\mathsf{N}, bi−𝖭b^{\\mathsf{N}}\_{i-}. Consider two possible bid values bib\_{i} and bi′b^{\\prime}\_{i} s.t. bi′>bib^{\\prime}\_{i}>b\_{i}. Define b𝖭=(bi,bi−𝖭)b^{\\mathsf{N}}=(b\_{i},b^{\\mathsf{N}}\_{i-}), b𝖭′=(bi′,bi−𝖭)b^{{}^{\\prime}\\mathsf{N}}=(b^{\\prime}\_{i},b^{\\mathsf{N}}\_{i-}), ibi=∑j∈𝖭𝟙​(bj≥bi)i\_{b\_{i}}=\\sum\_{j\\in\\mathsf{N}}\\mathds{1}(b\_{j}\\geq b\_{i}) and ibi′=∑j∈𝖭𝟙​(bj≥bi′)i\_{b^{\\prime}\_{i}}=\\sum\_{j\\in\\mathsf{N}}\\mathds{1}(b\_{j}\\geq b^{\\prime}\_{i}). Then the following holds:

(1) If k∗​(b𝖭,c)≥ibik^{\*}(b^{\\mathsf{N}},c)\\geq i\_{b\_{i}}, then k∗​(b𝖭′,c)=k∗​(b𝖭,c)k^{\*}(b^{{}^{\\prime}\\mathsf{N}},c)=k^{\*}(b^{\\mathsf{N}},c) and p∗​(b𝖭′,c)=p∗​(b𝖭,c)p^{\*}(b^{{}^{\\prime}\\mathsf{N}},c)=p^{\*}(b^{\\mathsf{N}},c).

(2) If k∗​(b𝖭,c)<ibik^{\*}(b^{\\mathsf{N}},c)<i\_{b\_{i}}, then k∗​(b𝖭′,c)<min⁡{ibi,r+1}k^{\*}(b^{{}^{\\prime}\\mathsf{N}},c)<\\min\\{i\_{b\_{i}},r+1\\} and p∗​(b𝖭′,c)≥max⁡{bi,br+1𝖭}p^{\*}(b^{{}^{\\prime}\\mathsf{N}},c)\\geq\\max\\{b\_{i},b^{\\mathsf{N}}\_{r+1}\\}.

###### Proof.

In the Phase 2 of the DP procedure, the while loop condition M⁡(pk,𝖡kn¯)<𝔼⁡\[V⁡(pk−1,ℬk−1n¯)∣𝖡kn¯\]M(p\_{k},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}})<\\mathbb{E}\\left\[V(p\_{k-1},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k-1}})\\mid\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}\\right\] is met at k∗​(b𝖭,c)k^{\*}(b^{\\mathsf{N}},c) by definition. We consider the following two cases:

(1) k∗​(b𝖭,c)≥ibik^{\*}(b^{\\mathsf{N}},c)\\geq i\_{b\_{i}}: The top bid values {b1𝖭,⋯,bk∗​(b𝖭,c)𝖭}\\{b^{\\mathsf{N}}\_{1},\\cdots,b^{\\mathsf{N}}\_{k^{\*}(b^{\\mathsf{N}},c)}\\} are not used in the phase 2 of DP procedure by construction. If k∗​(b𝖭,c)≥ibik^{\*}(b^{\\mathsf{N}},c)\\geq i\_{b\_{i}}, then both bi′,bib^{\\prime}\_{i},b\_{i} remain in the top k∗​(b𝖭,c)k^{\*}(b^{\\mathsf{N}},c) bids. Hence, the increase in bid value from bib\_{i} to bi′b^{\\prime}\_{i} does not affect the DP outcome and k∗​(b𝖭′,c)=k∗​(b𝖭,c)k^{\*}(b^{{}^{\\prime}\\mathsf{N}},c)=k^{\*}(b^{\\mathsf{N}},c) and p∗​(b𝖭′,c)=p∗​(b𝖭,c)p^{\*}(b^{{}^{\\prime}\\mathsf{N}},c)=p^{\*}(b^{\\mathsf{N}},c).

(2) k∗​(b𝖭,c)<ibik^{\*}(b^{\\mathsf{N}},c)<i\_{b\_{i}}: By definition, ibi′<ibii\_{b^{\\prime}\_{i}}<i\_{b\_{i}} since bi′>bib^{\\prime}\_{i}>b\_{i}. The while loop in DP’s phase 2 evaluates the same conditions M⁡(pk,𝖡kn¯)<𝔼⁡\[V⁡(pk−1,ℬk−1n¯)∣𝖡kn¯\]M(p\_{k},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}})<\\mathbb{E}\\left\[V(p\_{k-1},\\overline{\\mathcal{B}^{\\textsc{n}}\_{k-1}})\\mid\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}\\right\] for all k>max⁡{ibi,ibi′}=ibik>\\max\\{i\_{b\_{i}},i\_{b^{\\prime}\_{i}}\\}=i\_{b\_{i}} irrespective of whether bids b𝖭b^{\\mathsf{N}} or b𝖭′b^{{}^{\\prime}\\mathsf{N}} are used. Since k∗​(b𝖭,c)<ibik^{\*}(b^{\\mathsf{N}},c)<i\_{b\_{i}}, we also know these while loop conditions are all met for k>ibik>i\_{b\_{i}}, and for both bids b𝖭b^{\\mathsf{N}} and b𝖭′b^{{}^{\\prime}\\mathsf{N}}. Hence, k∗​(b𝖭′,c)<min⁡{ibi,r+1}k^{\*}(b^{{}^{\\prime}\\mathsf{N}},c)<\\min\\{i\_{b\_{i}},r+1\\} and p∗​(b𝖭′,c)≥max⁡{bibi𝖭,br+1𝖭}p^{\*}(b^{{}^{\\prime}\\mathsf{N}},c)\\geq\\max\\{b^{\\mathsf{N}}\_{i\_{b\_{i}}},b^{\\mathsf{N}}\_{r+1}\\} for bids bi𝖭′b^{{}^{\\prime}\\mathsf{N}}\_{i}. Also note that k∗​(b𝖭,c)<min⁡{ibi,r+1}k^{\*}(b^{\\mathsf{N}},c)<\\min\\{i\_{b\_{i}},r+1\\} and p∗​(b𝖭,c)≥max⁡{bibi𝖭,br+1𝖭}p^{\*}(b^{\\mathsf{N}},c)\\geq\\max\\{b^{\\mathsf{N}}\_{i\_{b\_{i}}},b^{\\mathsf{N}}\_{r+1}\\} is always true when k∗​(b𝖭,c)<ibik^{\*}(b^{\\mathsf{N}},c)<i\_{b\_{i}}.
∎

For bid bib\_{i}, the corresponding utility of bidder ii is ui​(bi,bi−)=vi​xi​(bi,bi−)−pi​(bi,bi−)u\_{i}(b\_{i},b\_{i-})=v\_{i}x\_{i}(b\_{i},b\_{i-})-p\_{i}(b\_{i},b\_{i-}). Let viv\_{i} be the true valuation of bidder ii. We show that ui​(vi,bi−)≥ui​(bi,bi−)u\_{i}(v\_{i},b\_{i-})\\geq u\_{i}(b\_{i},b\_{i-}) for all possible bid values bib\_{i}, and hence that the mechanism is DSIC for bidder ii by definition. The C-PoP mechanism uses the DP oracle [2](https://arxiv.org/html/2511.12456v4#alg2 "Algorithm 2 ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") to calculate k∗​(b𝖭,c)k^{\*}(b^{\\mathsf{N}},c) and p∗​(b𝖭,c)p^{\*}(b^{\\mathsf{N}},c). The allocation rule for non-colluding bidder xi​(bi,bi−)=𝟙​(bi>p∗​(b𝖭,c))x\_{i}(b\_{i},b\_{i-})=\\mathds{1}(b\_{i}>p^{\*}(b^{\\mathsf{N}},c)) and pi​(bi,bi−)=p∗​(b𝖭,c)​𝟙​(bi>p∗​(b𝖭,c))p\_{i}(b\_{i},b\_{i-})=p^{\*}(b^{\\mathsf{N}},c)\\mathds{1}(b\_{i}>p^{\*}(b^{\\mathsf{N}},c)). The DP oracle always sets p∗​(b𝖭,c)≥bk∗​(b𝖭,c)+1𝖭p^{\*}(b^{\\mathsf{N}},c)\\geq b^{\\mathsf{N}}\_{k^{\*}(b^{\\mathsf{N}},c)+1}, where k∗​(b𝖭,c)k^{\*}(b^{\\mathsf{N}},c) is set through the phase 2 of its algorithm.

Define v𝖭=(vi,bi−𝖭)v^{\\mathsf{N}}=(v\_{i},b^{\\mathsf{N}}\_{i-}), b𝖭=(bi,bi−𝖭)b^{\\mathsf{N}}=(b\_{i},b^{\\mathsf{N}}\_{i-}), v𝖬=(v𝖭,b𝖢)v^{\\mathsf{M}}=(v^{\\mathsf{N}},b^{\\mathsf{C}}), b𝖬=(b𝖭,b𝖢)b^{\\mathsf{M}}=(b^{\\mathsf{N}},b^{\\mathsf{C}}), ivi=∑j∈𝖭𝟙​(bj≥vi)i\_{v\_{i}}=\\sum\_{j\\in\\mathsf{N}}\\mathds{1}(b\_{j}\\geq v\_{i}) and ibi=∑j∈𝖭𝟙​(bj≥bi)i\_{b\_{i}}=\\sum\_{j\\in\\mathsf{N}}\\mathds{1}(b\_{j}\\geq b\_{i}). We consider the following four cases.

#### Case 1: bi>vib\_{i}>v\_{i} and k∗​(v𝖭,c)≥ivik^{\*}(v^{\\mathsf{N}},c)\\geq i\_{v\_{i}}.

By Lemma [B.1](https://arxiv.org/html/2511.12456v4#A2.Thmtheorem1 "Lemma B.1. ‣ Non-colluders. ‣ B.2 Proof of Theorem ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information") (1), k∗​(b𝖭,c)=k∗​(v𝖭,c)k^{\*}(b^{\\mathsf{N}},c)=k^{\*}(v^{\\mathsf{N}},c) and p∗​(b𝖭,c)=p∗​(v𝖭,c)p^{\*}(b^{\\mathsf{N}},c)=p^{\*}(v^{\\mathsf{N}},c). Since bi>vib\_{i}>v\_{i} and p∗​(b𝖭,c)=p∗​(v𝖭,c)p^{\*}(b^{\\mathsf{N}},c)=p^{\*}(v^{\\mathsf{N}},c), it holds that xi​(b𝖭)≥xi​(v𝖭)x\_{i}(b^{\\mathsf{N}})\\geq x\_{i}(v^{\\mathsf{N}}) and pi​(b𝖭)≥pi​(v𝖭)p\_{i}(b^{\\mathsf{N}})\\geq p\_{i}(v^{\\mathsf{N}}). The utility with bids bib\_{i} and viv\_{i} are

|     |     |     |     |
| --- | --- | --- | --- |
|  |  | ui​(b𝖬)=(vi−p∗​(v𝖭,c))⋅𝟙​(bi>p∗​(v𝖭,c))\\displaystyle u\_{i}(b^{\\mathsf{M}})=\\big(v\_{i}-p^{\*}(v^{\\mathsf{N}},c)\\big)\\cdot\\mathds{1}\\big(b\_{i}>p^{\*}(v^{\\mathsf{N}},c)\\big) |  |
|  |  | ui​(v𝖬)=(vi−p∗​(v𝖭,c))⋅𝟙​(vi>p∗​(v𝖭,c))\\displaystyle u\_{i}(v^{\\mathsf{M}})=\\big(v\_{i}-p^{\*}(v^{\\mathsf{N}},c)\\big)\\cdot\\mathds{1}\\big(v\_{i}>p^{\*}(v^{\\mathsf{N}},c)\\big) |  |

If bi>vi>p∗​(v𝖭,c)b\_{i}>v\_{i}>p^{\*}(v^{\\mathsf{N}},c), then ui​(b𝖬)=ui​(v𝖬)=vi−p∗​(v𝖭,c)u\_{i}(b^{\\mathsf{M}})=u\_{i}(v^{\\mathsf{M}})=v\_{i}-p^{\*}(v^{\\mathsf{N}},c). If p∗​(v𝖭,c)>bi>vip^{\*}(v^{\\mathsf{N}},c)>b\_{i}>v\_{i}, then ui​(b𝖬)=ui​(v𝖬)=0u\_{i}(b^{\\mathsf{M}})=u\_{i}(v^{\\mathsf{M}})=0. If bi>p∗​(v𝖭,c)>vib\_{i}>p^{\*}(v^{\\mathsf{N}},c)>v\_{i}, then ui​(b𝖬)=vi−p∗​(v𝖭,c)<0u\_{i}(b^{\\mathsf{M}})=v\_{i}-p^{\*}(v^{\\mathsf{N}},c)<0 and ui​(v𝖬)=0u\_{i}(v^{\\mathsf{M}})=0. Hence, ui​(v𝖬)≥ui​(b𝖬)u\_{i}(v^{\\mathsf{M}})\\geq u\_{i}(b^{\\mathsf{M}}) holds in this case.

#### Case 2: bi>vib\_{i}>v\_{i} and k∗​(v𝖭,c)<ivik^{\*}(v^{\\mathsf{N}},c)<i\_{v\_{i}}.

By lemma ( [B.1](https://arxiv.org/html/2511.12456v4#A2.Thmtheorem1 "Lemma B.1. ‣ Non-colluders. ‣ B.2 Proof of Theorem ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information")) (2), k∗​(b𝖭,c)<min⁡{ivi,r+1}k^{\*}(b^{\\mathsf{N}},c)<\\min\\{i\_{v\_{i}},r+1\\} and p∗​(b𝖭,c)≥max⁡{vi,vr+1𝖭}p^{\*}(b^{\\mathsf{N}},c)\\geq\\max\\{v\_{i},v^{\\mathsf{N}}\_{r+1}\\}. Since, k∗​(v𝖭,c)<ivik^{\*}(v^{\\mathsf{N}},c)<i\_{v\_{i}}, no item is allocated to bidder ii when they bid viv\_{i}, i.e., xi​(v𝖭)=0x\_{i}(v^{\\mathsf{N}})=0, pi​(v𝖭)=0p\_{i}(v^{\\mathsf{N}})=0 and ui​(v𝖬)=0u\_{i}(v^{\\mathsf{M}})=0. The utility with bid bib\_{i}

|     |     |     |     |
| --- | --- | --- | --- |
|  | ui​(b𝖬)\\displaystyle u\_{i}(b^{\\mathsf{M}}) | =(vi−p∗​(b𝖭))⋅(𝟙​(bi>p∗​(b𝖭))CLOSE\\displaystyle=\\big(v\_{i}-p^{\*}(b^{\\mathsf{N}})\\big)\\cdot\\big(\\mathds{1}(b\_{i}>p^{\*}(b^{\\mathsf{N}})\\big) |  |
|  |  | ≤vi−p∗​(b𝖭)≤vi−max⁡{vi,vr+1𝖭}\\displaystyle\\leq v\_{i}-p^{\*}(b^{\\mathsf{N}})\\leq v\_{i}-\\max\\{v\_{i},v^{\\mathsf{N}}\_{r+1}\\} |  |
|  |  | ≤0=ui​(v𝖬).\\displaystyle\\leq 0=u\_{i}(v^{\\mathsf{M}}). |  |

#### Case 3: bi<vib\_{i}<v\_{i} and k∗​(b𝖭,c)≥ibik^{\*}(b^{\\mathsf{N}},c)\\geq i\_{b\_{i}}.

From lemma ( [B.1](https://arxiv.org/html/2511.12456v4#A2.Thmtheorem1 "Lemma B.1. ‣ Non-colluders. ‣ B.2 Proof of Theorem ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information")) (1), it is true that k∗​(b𝖭,c)=k∗​(v𝖭,c)k^{\*}(b^{\\mathsf{N}},c)=k^{\*}(v^{\\mathsf{N}},c) and p∗​(b𝖭,c)=p∗​(v𝖭,c)p^{\*}(b^{\\mathsf{N}},c)=p^{\*}(v^{\\mathsf{N}},c). Then, comparing the utilities,

|     |     |     |     |
| --- | --- | --- | --- |
|  | ui​(b𝖬)\\displaystyle u\_{i}(b^{\\mathsf{M}}) | =(vi−p∗​(v𝖭,c))⋅𝟙​(bi>p∗​(v𝖭,c))\\displaystyle=\\big(v\_{i}-p^{\*}(v^{\\mathsf{N}},c)\\big)\\cdot\\mathds{1}\\big(b\_{i}>p^{\*}(v^{\\mathsf{N}},c)\\big) |  |
|  |  | ≤(vi−p∗(v𝖭,c))⋅𝟙(vi>p∗(v𝖭,c))(∵vi>bi)\\displaystyle\\leq\\big(v\_{i}-p^{\*}(v^{\\mathsf{N}},c)\\big)\\cdot\\mathds{1}\\big(v\_{i}>p^{\*}(v^{\\mathsf{N}},c)\\big)\\quad(\\because v\_{i}>b\_{i}) |  |
|  |  | =ui​(v𝖬).\\displaystyle=u\_{i}(v^{\\mathsf{M}}). |  |

#### Case 4: bi<vib\_{i}<v\_{i} and k∗​(b𝖭,c)<ibik^{\*}(b^{\\mathsf{N}},c)<i\_{b\_{i}}.

By lemma ( [B.1](https://arxiv.org/html/2511.12456v4#A2.Thmtheorem1 "Lemma B.1. ‣ Non-colluders. ‣ B.2 Proof of Theorem ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information")) (2), k∗​(b𝖭,c)<min⁡{ibi,r+1}k^{\*}(b^{\\mathsf{N}},c)<\\min\\{i\_{b\_{i}},r+1\\} and p∗​(b𝖭,c)≥max⁡{bi,br+1𝖭}p^{\*}(b^{\\mathsf{N}},c)\\geq\\max\\{b\_{i},b^{\\mathsf{N}}\_{r+1}\\}. Since, k∗​(b𝖭,c)<ibik^{\*}(b^{\\mathsf{N}},c)<i\_{b\_{i}}, no item is allocated to bidder ii when they bid bib\_{i}, i.e., xi​(b𝖭)=0x\_{i}(b^{\\mathsf{N}})=0, pi​(b𝖭)=0p\_{i}(b^{\\mathsf{N}})=0 and ui​(b𝖬)=0u\_{i}(b^{\\mathsf{M}})=0. Hence, ui​(v𝖬)≥ui​(b𝖬)u\_{i}(v^{\\mathsf{M}})\\geq u\_{i}(b^{\\mathsf{M}}) holds trivially.

#### Colluders.

Consider bidder i∈𝖢i\\in\\mathsf{C}. The remaining r−w𝖭r-w\_{\\mathsf{N}} items, where w𝖭w\_{\\mathsf{N}} is independent of the colluding bids, are allocated to colluders via the posted price p∗​(bn,c)p^{\*}(b^{\\textsc{n}},c). In our model for colluding bidders, we consider them to be maximizing their total utility ∑i∈cui​(b𝖬)\\sum\_{i\\in\\textsc{c}}u\_{i}(b^{\\mathsf{M}}). Since they exchange monetary payments and items amongst themselves, it suffices to consider the top bidding colluders while calculating their net utility. Hence, ∑i∈cui​(b𝖬)=∑i=1r−wn(vic−p∗​(bn,c))​1​(bic>p∗​(bn,c))\\sum\_{i\\in\\textsc{c}}u\_{i}(b^{\\mathsf{M}})=\\sum\_{i=1}^{r-w\_{\\textsc{n}}}\\left(v^{\\textsc{c}}\_{i}-p^{\*}(b^{\\textsc{n}},c)\\right)1\\big(b^{\\textsc{c}}\_{i}>p^{\*}(b^{\\textsc{n}},c)\\big). For any p∗​(bn,c)p^{\*}(b^{\\textsc{n}},c), this net utility is maximized when vic>p∗​(bn,c)⇒1​(bic>p∗​(bn,c))=1v^{\\textsc{c}}\_{i}>p^{\*}(b^{\\textsc{n}},c)\\Rightarrow 1\\big(b^{\\textsc{c}}\_{i}>p^{\*}(b^{\\textsc{n}},c)\\big)=1. Hence, bidding truthfully, i.e., vic=bicv\_{i}^{\\textsc{c}}=b\_{i}^{\\textsc{c}}∀i∈C\\forall i\\in C is a utility-maximizing strategy.

Hence, for every bidder, truthful reporting is a weakly dominant strategy, and the mechanism is (ex-post) DSIC.

### B.3 Proof of Proposition [4.4](https://arxiv.org/html/2511.12456v4\#S4.Thmtheorem4 "Proposition 4.4. ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information")

#### Correctly classified non-colluders.

Consider i∈𝖭t.i\\in\\mathsf{N}\_{\\textsc{t}}. Fix the bids from other bidders bi−b\_{i-}. The lemma [B.1](https://arxiv.org/html/2511.12456v4#A2.Thmtheorem1 "Lemma B.1. ‣ Non-colluders. ‣ B.2 Proof of Theorem ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information") (using 𝖭^\\widehat{\\mathsf{N}} instead of 𝖭\\mathsf{N}, and \|𝖢^\|\|\\widehat{\\mathsf{C}}\| instead of \|𝖢\|\|\\mathsf{C}\|) can be used to characterize how the bidder ii’s reported bids affects the outcomes of the DP oracle. Subsequently, we can consider four cases with respect to the true valuation of bidder viv\_{i} as in the proof of theorem [4.3](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem3 "Theorem 4.3 (C-PoP Truthfulness). ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") to prove truthfulness.

#### Incorrectly classified non-colluders.

Consider i∈𝖭f.i\\in\\mathsf{N}\_{\\textsc{f}}. Their utility ui​(b𝖬)=vi−p∗​(b𝖭^,\|𝖢^\|)​𝟙​(bi>p∗​(b𝖭^,\|𝖢^\|))u\_{i}(b^{\\mathsf{M}})=v\_{i}-p^{\*}(b^{\\widehat{\\mathsf{N}}},\|\\widehat{\\mathsf{C}}\|)\\mathds{1}(b\_{i}>p^{\*}(b^{\\widehat{\\mathsf{N}}},\|\\widehat{\\mathsf{C}}\|)), where bib\_{i}, viv\_{i} is their reported and true valuation respectively and the price p∗​(b𝖭^,\|𝖢^\|)p^{\*}(b^{\\widehat{\\mathsf{N}}},\|\\widehat{\\mathsf{C}}\|) is independent of their reported bid value. Hence, their utility is maximized when vi>p∗​(b𝖭^,\|𝖢^\|)⇒𝟙​(bi>p∗​(b𝖭^,\|𝖢^\|))=1v\_{i}>p^{\*}(b^{\\widehat{\\mathsf{N}}},\|\\widehat{\\mathsf{C}}\|)\\Rightarrow\\mathds{1}\\big(b\_{i}>p^{\*}(b^{\\widehat{\\mathsf{N}}},\|\\widehat{\\mathsf{C}}\|)\\big)=1 and truthful reporting vi=biv\_{i}=b\_{i} is a utility-maximizing strategy.

#### Price lower bound.

When \|𝖭f\|≥r+1\|\\mathsf{N}\_{\\textsc{f}}\|\\geq r+1, the DP oracle is assured to set a price p∗​(b𝖭^,\|𝖢^\|)≥br+1𝖭^≥br+1𝖭tp^{\*}(b^{\\widehat{\\mathsf{N}}},\|\\widehat{\\mathsf{C}}\|)\\geq b^{\\widehat{\\mathsf{N}}}\_{r+1}\\geq b^{\\mathsf{N}\_{\\textsc{t}}}\_{r+1}.

### B.4 Proof of Proposition [4.6](https://arxiv.org/html/2511.12456v4\#S4.Thmtheorem6 "Proposition 4.6. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information")

If the C-PoP mechanism was run only on a set of non-colluders 𝖭\\mathsf{N}, then the mechanism would allocate all the rr items to bidders in 𝖭\\mathsf{N}. The DP oracle would set the price using prp\_{r} as follows.

|     |     |     |     |
| --- | --- | --- | --- |
|  |  | p∗​(b𝖭,0)=pr=arg⁡maxp≥br+1𝖭⁡𝔼⁡\[∑i=1rbi𝖭​𝟙​(bi𝖭>br+1𝖭)\]=br+1𝖭\\displaystyle p^{\*}(b^{\\mathsf{N}},0)=p\_{r}=\\arg\\max\_{p\\geq b^{\\mathsf{N}}\_{r+1}}\\mathbb{E}\[\\sum\_{i=1}^{r}b^{\\mathsf{N}}\_{i}\\mathds{1}(b^{\\mathsf{N}}\_{i}>b^{\\mathsf{N}}\_{r+1})\]=b^{\\mathsf{N}}\_{r+1} |  |

Since the price is set at br+1𝖭b^{\\mathsf{N}}\_{r+1}, the C-PoP mechanism would allocate items to the top rr bids in 𝖭\\mathsf{N}. Therefore, it also holds that xi​(b𝖭,∅)=𝟙​(bi𝖭>br+1𝖭).x\_{i}(b^{\\mathsf{N}},\\emptyset)=\\mathds{1}(b^{\\mathsf{N}}\_{i}>b^{\\mathsf{N}}\_{r+1}). Hence, the C-PoP mechanism and VCG are equivalent when run on a set of classified non-colluders and without any bidders classified as colluders.

### B.5 Proof of Proposition [4.5](https://arxiv.org/html/2511.12456v4\#S4.Thmtheorem5 "Proposition 4.5 (Conditional Expected Welfare). ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information")

Since, the C-PoP mechanism induces truthful bidding from Theorem [4.3](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem3 "Theorem 4.3 (C-PoP Truthfulness). ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), Bn=VnB^{\\textsc{n}}=V^{\\textsc{n}}. First note that the expected welfare conditioned on all the non-colluding Vkn¯\\overline{V^{\\textsc{n}}\_{k}} is the same as that conditioned on highest non-colluding losing bid Vk+1nV^{\\textsc{n}}\_{k+1}. Also, since the colluding bidders can exchange both items and monetary payments among themselves, the specific allocation of items to individual bidders is irrelevant. For welfare computation, it suffices to consider the highest colluding bids among the winners. Using Assumption [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmassumption1 "Assumption 4.1. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") and probability integral transform of continuous random variables, Vkn=𝖰⁡(Ukn)V^{\\textsc{n}}\_{k}=\\mathsf{Q}(U^{\\textsc{n}}\_{k}) (see Equation (2.3.7)(2.3.7) of [David and Nagaraja \[2003\]](https://arxiv.org/html/2511.12456v4#bib.bib13 "")), where UknU^{\\textsc{n}}\_{k} is k−k-th largest order statistic of NN samples of standard uniform random variables. Using 𝖰​(⋅)=𝖥−1​(⋅)\\mathsf{Q}(\\cdot)=\\mathsf{F}^{-1}(\\cdot), we get 𝖥⁡(Vkn)=Ukn\\mathsf{F}(V^{\\textsc{n}}\_{k})=U^{\\textsc{n}}\_{k}. We use these facts to simplify the expression 𝔼\[𝚆𝚎𝚕C-PoP(𝖭,𝖢;p)∣p≥Vk+1n,Vkn¯\]=𝔼\[∑i∈𝖬Vixi(V𝖬)∣p≥Vk+1n,Vk+1n\]\\textstyle\\mathbb{E}\\left\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\mid p\\geq V^{\\textsc{n}}\_{k+1},\\overline{V^{\\textsc{n}}\_{k}}\\right\]=\\mathbb{E}\\left\[\\sum\_{i\\in\\mathsf{M}}V\_{i}x\_{i}(V^{\\mathsf{M}})\\mid p\\geq V^{\\textsc{n}}\_{k+1},V^{\\textsc{n}}\_{k+1}\\right\], where 𝖬=𝖭,𝖢\\mathsf{M}=\\mathsf{N},\\mathsf{C}.

Let wnw\_{\\textsc{n}} be the number of non-colluding bids above the price pp. Then, wn∼Binom⁡(k,1−𝖥⁡(p)1−𝖥⁡(Vk+1n))w\_{\\textsc{n}}\\sim\\mathrm{Binom}\\big(k,\\frac{1-\\mathsf{F}(p)}{1-\\mathsf{F}(V^{\\textsc{n}}\_{k+1})}\\big). Similarly, let wcw\_{\\textsc{c}} be the number of colluding bids above the price pp, and wc∼Binom⁡(𝖢,1−𝖥⁡(p))w\_{\\textsc{c}}\\sim\\mathrm{Binom}\\big(\\mathsf{C},1-\\mathsf{F}(p)\\big).

|     |     |     |     |
| --- | --- | --- | --- |
|  |  | 𝔼\[∑i∈𝖬Vixi(V𝖬)\|p≥Vnk+1,Vnk+1\]\\displaystyle\\textstyle\\displaystyle\\mathbb{E}\\big\[\\sum\_{i\\in\\mathsf{M}}V\_{i}x\_{i}(V^{\\mathsf{M}})\ \|\ p\\geq V^{\\textsc{n}}\_{k+1},V^{\\textsc{n}}\_{k+1}\\big\] |  |
|  |  | =𝔼⁡\[∑j=1w𝖭Vjk∣Vkk>p\]+𝔼⁡\[∑j=1r−wn−1ℙ⁡(wc=j)​𝔼​\[∑i=1jVij∣Vjj>p\]\]\\displaystyle=\\textstyle\\mathbb{E}\\big\[\\sum\_{j=1}^{w\_{\\mathsf{N}}}V^{k}\_{j}\\mid V^{k}\_{k}>p\\big\]+\\mathbb{E}\\big\[\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\sum\_{i=1}^{j}V\_{i}^{j}\\mid V\_{j}^{j}>p\\big\]\\big\] |  |
|  |  | +𝔼⁡\[∑j=r−wncℙ⁡(wc=j)​𝔼​\[∑i=1r−wnVij∣Vjj>p\]\]\\displaystyle\\textstyle\\displaystyle+\\mathbb{E}\\big\[\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\sum\_{i=1}^{r-w\_{\\textsc{n}}}V\_{i}^{j}\\mid V\_{j}^{j}>p\\big\]\\big\] |  |
|  |  | =𝔼⁡\[wn\]​𝔼​\[V\|V>p\]+𝔼⁡\[∑j=1r−wn−1j​ℙ​(wc=j)​𝔼​\[V∣V>p\]\]\\displaystyle=\\textstyle\\mathbb{E}\\big\[w\_{\\textsc{n}}\\big\]\\mathbb{E}\\big\[V\ \|\ V>p\\big\]+\\mathbb{E}\\big\[\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}j\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[V\\mid V>p\\big\]\\big\] |  |
|  |  | +𝔼⁡\[∑j=r−wncℙ⁡(wc=j)​𝔼​\[∑i=1r−wnVij∣Vjj>p\]\]\\displaystyle\\textstyle\\displaystyle+\\mathbb{E}\\big\[\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\sum\_{i=1}^{r-w\_{\\textsc{n}}}V\_{i}^{j}\\mid V\_{j}^{j}>p\\big\]\\big\] |  |
|  |  | =𝔼⁡\[wn\]​𝔼​\[𝖰⁡(U)\|U>𝖥⁡(p)\]+𝔼⁡\[∑j=1r−wn−1j​ℙ​(wc=j)​𝔼​\[𝖰⁡(U)∣U>𝖥⁡(p)\]\]\\displaystyle=\\textstyle\\mathbb{E}\\big\[w\_{\\textsc{n}}\\big\]\\mathbb{E}\\big\[\\mathsf{Q}(U)\ \|\ U>\\mathsf{F}(p)\\big\]+\\mathbb{E}\\big\[\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}j\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\mathsf{Q}(U)\\mid U>\\mathsf{F}(p)\\big\]\\big\] |  |
|  |  | +𝔼⁡\[∑j=r−wncℙ⁡(wc=j)​𝔼​\[∑i=1r−wn𝖰⁡(Uij)∣Ujj>𝖥⁡(p)\]\],\\displaystyle\\textstyle\\displaystyle+\\mathbb{E}\\big\[\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\sum\_{i=1}^{r-w\_{\\textsc{n}}}\\mathsf{Q}(U\_{i}^{j})\\mid U\_{j}^{j}>\\mathsf{F}(p)\\big\]\\big\], |  |

where U∼Uniform⁡\[0,1\]U\\sim\\mathrm{Uniform}\[0,1\].

### B.6 Proof of Theorem [4.7](https://arxiv.org/html/2511.12456v4\#S4.Thmtheorem7 "Theorem 4.7 (Expected Welfare Optimization). ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information")

By Theorem [4.3](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem3 "Theorem 4.3 (C-PoP Truthfulness). ‣ 4.1 Conditional-Posted Price (C-PoP) Mechanism ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), all bids are known to be truthful. When k∗=rk^{\*}=r as in Proposition [4.6](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem6 "Proposition 4.6. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), C-PoP mechanism allocates all items to the non-colluding bidders and is equivalent to the VCG mechanism. Hence, 𝚆𝚎𝚕C-PoP(𝖭,𝖢;p=pr=br+1𝖭)=𝚆𝚎𝚕VCG(𝖭,∅)\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p=p\_{r}=b^{\\mathsf{N}}\_{r+1})=\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N},\\emptyset). If C-PoP uses a k∗<rk^{\*}<r then, define:

|     |     |     |     |
| --- | --- | --- | --- |
|  | p∗\\displaystyle p^{\*} | =argmaxp≥bk∗+1𝖭𝔼\[𝚆𝚎𝚕C-PoP(𝖭,𝖢;p)∣p≥bk∗+1𝖭,bk∗+1𝖭\]\\displaystyle=\\arg\\max\_{p\\geq b^{\\mathsf{N}}\_{k^{\*}+1}}\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\mid p\\geq b^{\\mathsf{N}}\_{k^{\*}+1},b^{\\mathsf{N}}\_{k^{\*}+1}\] |  |
|  | p^∗\\displaystyle\\hat{p}^{\*} | =argmaxp≥br+1𝖭𝔼\[𝚆𝚎𝚕C-PoP(𝖭,∅;p)∣p≥br+1𝖭,br+1𝖭\]\\displaystyle=\\arg\\max\_{p\\geq b^{\\mathsf{N}}\_{r+1}}\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\emptyset;p)\\mid p\\geq b^{\\mathsf{N}}\_{r+1},b^{\\mathsf{N}}\_{r+1}\] |  |

We use the above definitions to derive the welfare bounds.

|     |     |     |     |
| --- | --- | --- | --- |
|  | 𝔼⁡\[𝔼⁡\[𝚆𝚎𝚕C-PoP​(𝖭,𝖢,p∗)∣bk∗+1𝖭\]\]\\displaystyle\\mathbb{E}\[\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p^{\*})\\mid b^{\\mathsf{N}}\_{k^{\*}+1}\]\] | ≥𝔼⁡\[𝔼⁡\[𝚆𝚎𝚕C-PoP​(𝖭,𝖢,p^∗)∣bk∗+1𝖭\]\]\\displaystyle\\geq\\mathbb{E}\[\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};\\hat{p}^{\*})\\mid b^{\\mathsf{N}}\_{k^{\*}+1}\]\] |  |
|  |  | ≥𝔼⁡\[𝔼⁡\[𝚆𝚎𝚕C-PoP​(𝖭,∅,p^∗)∣bk∗+1𝖭\]\]\\displaystyle\\geq\\mathbb{E}\[\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\emptyset;\\hat{p}^{\*})\\mid b^{\\mathsf{N}}\_{k^{\*}+1}\]\] |  |
|  |  | =𝔼⁡\[𝚆𝚎𝚕C-PoP​(𝖭,∅,p^∗)∣br∗+1𝖭\]\\displaystyle=\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\emptyset;\\hat{p}^{\*})\\mid b^{\\mathsf{N}}\_{r^{\*}+1}\] |  |
|  |  | =𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭,∅)\].\\displaystyle=\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N},\\emptyset)\]. |  |

### B.7 Proof of Corollary [4.8](https://arxiv.org/html/2511.12456v4\#S4.Thmtheorem8 "Corollary 4.8. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information")

Observe that 𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭)\]≤𝔼⁡\[𝚆𝚎𝚕C-PoP​(𝖭,𝖢,p∗)\]≤𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭∪𝖢,∅)\]\\mathbb{E}\\left\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N})\\right\]\\leq\\mathbb{E}\\left\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p^{\*})\\right\]\\leq\\mathbb{E}\\left\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N}\\cup\\mathsf{C},\\emptyset)\\right\], where the first inequality holds by Theorem [4.7](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem7 "Theorem 4.7 (Expected Welfare Optimization). ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") and the second inequality holds by the efficiency of VCG for noncollusive bidders. When number of items rr is fixed and 𝖥⁡(⋅)\\mathsf{F}(\\cdot) has a bounded support, then limn→∞𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭,𝖢)\]−𝔼⁡\[𝚆𝚎𝚕VCG​(𝖭)\]=0\\textstyle\\lim\_{n\\to\\infty}\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N},\\mathsf{C})\]-\\mathbb{E}\[\\mathtt{Wel}\_{\\textsc{VCG}}(\\mathsf{N})\]=0 holds. The result thus follows.

### B.8 Construction of Minorants for (Conditional) Expected Welfare

The next lemma links order statistics of bidders’ valuations to those of samples from a uniform distribution, establishing a simple way to bound valuations using the quantile function’s upper and lower slopes.

###### Lemma B.2.

Given that Assumptions [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmassumption1 "Assumption 4.1. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") and [4.2](https://arxiv.org/html/2511.12456v4#S4.Thmassumption2 "Assumption 4.2. ‣ 4.4 Expected Welfare Optimization for Partially-Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") hold, an order statistic VksV^{\\textsc{s}}\_{k} satisfies L​Uks≤VksLU^{\\textsc{s}}\_{k}\\leq V^{\\textsc{s}}\_{k}, where UksU^{\\textsc{s}}\_{k} is the k-th largest order statistic among SS i.i.d. standard uniform samples. Furthermore, 𝖥⁡(Vkn)=Ukn\\mathsf{F}(V^{\\textsc{n}}\_{k})=U^{\\textsc{n}}\_{k}.

###### Proof.

The result is a consequence of the probability integral transform of continuous random variables. By equation (2.3.7)(2.3.7) of [David and Nagaraja \[2003\]](https://arxiv.org/html/2511.12456v4#bib.bib13 ""), Vks=𝖰⁡(Uks)V^{\\textsc{s}}\_{k}=\\mathsf{Q}(U^{\\textsc{s}}\_{k}). L​Uks≤VksLU^{\\textsc{s}}\_{k}\\leq V^{\\textsc{s}}\_{k} follows from Assumption [4.2](https://arxiv.org/html/2511.12456v4#S4.Thmassumption2 "Assumption 4.2. ‣ 4.4 Expected Welfare Optimization for Partially-Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"). Using 𝖰​(⋅)=𝖥−1​(⋅)\\mathsf{Q}(\\cdot)=\\mathsf{F}^{-1}(\\cdot) from Assumption [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmassumption1 "Assumption 4.1. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"), we get 𝖥⁡(Vkn)=Ukn\\mathsf{F}(V^{\\textsc{n}}\_{k})=U^{\\textsc{n}}\_{k}.
∎

Next, we construct two different minorants for expected welfare.

###### Proposition B.3(Minorant of Welfare).

Let Assumptions [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmassumption1 "Assumption 4.1. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") and [4.2](https://arxiv.org/html/2511.12456v4#S4.Thmassumption2 "Assumption 4.2. ‣ 4.4 Expected Welfare Optimization for Partially-Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") hold. Then,

|     |     |     |     |
| --- | --- | --- | --- |
|  |  | 𝔼\[𝚆𝚎𝚕C-PoP(𝖭,𝖢;p)\]≥𝔼\[L⁡(1+Uk+1𝖭)2×\\displaystyle\\textstyle\\mathbb{E}\\left\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\right\]\\geq\\mathbb{E}\\big\[\\frac{L(1+U^{\\mathsf{N}}\_{k+1})}{2}\\times |  |\
|  |  | 𝔼\[wn+∑j=1r−wn−1jℙ(wc=j)+∑j=r−wncℙ(wc=j)2​(r−w𝖭)(1+Uk+1𝖭)(1−(1−Uk+1𝖭)​(r−w𝖭+1)(j+1))∣Uk+1n\]\].\\displaystyle\\textstyle\\mathbb{E}\\big\[w\_{\\textsc{n}}+\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}j\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)+\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\frac{2(r-w\_{\\mathsf{N}})}{(1+U^{\\mathsf{N}}\_{k+1})}(1-\\frac{(1-U^{\\mathsf{N}}\_{k+1})(r-w\_{\\mathsf{N}}+1)}{(j+1)})\\mid U^{\\textsc{n}}\_{k+1}\\big\]\\big\]. |  |

where wn∼Binom⁡(k,1−𝖥⁡(p)1−Uk+1n)w\_{\\textsc{n}}\\sim\\mathrm{Binom}\\big(k,\\frac{1-\\mathsf{F}(p)}{1-U^{\\textsc{n}}\_{k+1}}\\big), wc∼Binom⁡(𝖢,1−𝖥⁡(p))w\_{\\textsc{c}}\\sim\\mathrm{Binom}\\big(\\mathsf{C},1-\\mathsf{F}(p)\\big) and Uk+1𝖭∼Beta⁡(n−k,k+1)U^{\\mathsf{N}}\_{k+1}\\sim\\mathrm{Beta}(n-k,k+1).

###### Proof.

By Proposition [4.5](https://arxiv.org/html/2511.12456v4#S4.Thmtheorem5 "Proposition 4.5 (Conditional Expected Welfare). ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information"),

|     |     |     |     |
| --- | --- | --- | --- |
|  |  | 𝔼\[𝚆𝚎𝚕C-PoP(𝖭,𝖢;p)∣p≥b𝖭k+1,𝖡kn¯\]\\displaystyle\\textstyle\\displaystyle\\mathbb{E}\\left\[\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\mid p\\geq b^{\\mathsf{N}}\_{k+1},\\overline{\\mathsf{B}^{\\textsc{n}}\_{k}}\\right\] |  |
|  |  | =𝔼⁡\[wn\]​𝔼​\[𝖰⁡(U)\|U>𝖥⁡(p)\]+𝔼⁡\[∑j=1r−wn−1j​ℙ​(wc=j)​𝔼​\[𝖰⁡(U)∣U>𝖥⁡(p)\]\]\\displaystyle=\\textstyle\\mathbb{E}\\big\[w\_{\\textsc{n}}\\big\]\\mathbb{E}\\big\[\\mathsf{Q}(U)\ \|\ U>\\mathsf{F}(p)\\big\]+\\mathbb{E}\\big\[\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}j\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\mathsf{Q}(U)\\mid U>\\mathsf{F}(p)\\big\]\\big\] |  |
|  |  | +𝔼⁡\[∑j=r−wncℙ⁡(wc=j)​𝔼​\[∑i=1r−wn𝖰⁡(Uij)∣Ujj>𝖥⁡(p)\]\],\\displaystyle\\textstyle\\displaystyle+\\mathbb{E}\\big\[\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\sum\_{i=1}^{r-w\_{\\textsc{n}}}\\mathsf{Q}(U\_{i}^{j})\\mid U\_{j}^{j}>\\mathsf{F}(p)\\big\]\\big\], |  |

where U∼Uniform⁡\[0,1\]U\\sim\\mathrm{Uniform}\[0,1\], wn∼Binom⁡(k,1−𝖥⁡(p)1−𝖥⁡(Vk+1n))w\_{\\textsc{n}}\\sim\\mathrm{Binom}\\big(k,\\frac{1-\\mathsf{F}(p)}{1-\\mathsf{F}(V^{\\textsc{n}}\_{k+1})}\\big), and wc∼Binom⁡(𝖢,1−𝖥⁡(p))w\_{\\textsc{c}}\\sim\\mathrm{Binom}\\big(\\mathsf{C},1-\\mathsf{F}(p)\\big).
Using Assumption [4.2](https://arxiv.org/html/2511.12456v4#S4.Thmassumption2 "Assumption 4.2. ‣ 4.4 Expected Welfare Optimization for Partially-Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") and Lemma [B.2](https://arxiv.org/html/2511.12456v4#A2.Thmtheorem2 "Lemma B.2. ‣ B.8 Construction of Minorants for (Conditional) Expected Welfare ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information"), we bound the above terms as follows.

|     |     |     |     |
| --- | --- | --- | --- |
|  |  | 𝔼⁡\[wn\]​𝔼​\[𝖰⁡(U)\|U>𝖥⁡(p)\]+𝔼⁡\[∑j=1r−wn−1j​ℙ​(wc=j)​𝔼​\[𝖰⁡(U)∣U>𝖥⁡(p)\]\]\\displaystyle\\textstyle\\mathbb{E}\\big\[w\_{\\textsc{n}}\\big\]\\mathbb{E}\\big\[\\mathsf{Q}(U)\ \|\ U>\\mathsf{F}(p)\\big\]+\\mathbb{E}\\big\[\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}j\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\mathsf{Q}(U)\\mid U>\\mathsf{F}(p)\\big\]\\big\] |  |
|  |  | +𝔼⁡\[∑j=r−wncℙ⁡(wc=j)​𝔼​\[∑i=1r−wn𝖰⁡(Uij)∣Ujj>𝖥⁡(p)\]\]\\displaystyle\\textstyle\\quad+\\mathbb{E}\\big\[\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\sum\_{i=1}^{r-w\_{\\textsc{n}}}\\mathsf{Q}(U\_{i}^{j})\\mid U\_{j}^{j}>\\mathsf{F}(p)\\big\]\\big\] |  |
|  |  | ≥𝔼⁡\[wn\]​𝔼​\[L​U\|U>Uk+1𝖭\]+𝔼⁡\[∑j=1r−wn−1j​ℙ​(wc=j)​𝔼​\[L​U∣U>Uk+1𝖭\]\]\\displaystyle\\geq\\textstyle\\mathbb{E}\\big\[w\_{\\textsc{n}}\\big\]\\mathbb{E}\\big\[LU\ \|\ U>U^{\\mathsf{N}}\_{k+1}\\big\]+\\mathbb{E}\\big\[\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}j\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[LU\\mid U>U^{\\mathsf{N}}\_{k+1}\\big\]\\big\] |  |
|  |  | +𝔼⁡\[∑j=r−wncℙ⁡(wc=j)​𝔼​\[∑i=1r−wnL​Uij∣Ujj>Uk+1𝖭\]\]\\displaystyle\\textstyle\\quad+\\mathbb{E}\\big\[\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mathbb{E}\\big\[\\sum\_{i=1}^{r-w\_{\\textsc{n}}}LU\_{i}^{j}\\mid U\_{j}^{j}>U^{\\mathsf{N}}\_{k+1}\\big\]\\big\] |  |
|  |  | ≥L⁡(1+Uk+1𝖭)2​𝔼​\[wn+∑j=1r−wn−1j​ℙ​(wc=j)\]\\displaystyle\\geq\\textstyle\\frac{L(1+U^{\\mathsf{N}}\_{k+1})}{2}\\mathbb{E}\\big\[w\_{\\textsc{n}}+\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}j\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\big\] |  |
|  |  | +L​𝔼​\[∑j=r−wncℙ⁡(wc=j)​(r−w𝖭)​(1−(1−Uk+1𝖭)​(r−w𝖭+1)2​(j+1))\]\\displaystyle\\textstyle\\quad+L\\mathbb{E}\\big\[\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)(r-w\_{\\mathsf{N}})(1-\\frac{(1-U^{\\mathsf{N}}\_{k+1})(r-w\_{\\mathsf{N}}+1)}{2(j+1)})\\big\] |  |
|  | =\\displaystyle= | 𝔼\[wn+∑j=1r−wn−1jℙ(wc=j)+∑j=r−wncℙ(wc=j)2​(r−w𝖭)(1+Uk+1𝖭)(1−(1−Uk+1𝖭)​(r−w𝖭+1)(j+1))\]×\\displaystyle\\textstyle\\mathbb{E}\\big\[w\_{\\textsc{n}}+\\sum\_{j=1}^{r-w\_{\\textsc{n}}-1}j\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)+\\sum\_{j=r-w\_{\\textsc{n}}}^{c}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\frac{2(r-w\_{\\mathsf{N}})}{(1+U^{\\mathsf{N}}\_{k+1})}(1-\\frac{(1-U^{\\mathsf{N}}\_{k+1})(r-w\_{\\mathsf{N}}+1)}{(j+1)})\\big\]\\times |  |
|  |  | L⁡(1+Uk+1𝖭)2\\displaystyle\\textstyle\\quad\\frac{L(1+U^{\\mathsf{N}}\_{k+1})}{2} |  |

The second inequality is because Q⁡(U)=V≥L​UQ(U)=V\\geq LU by Lemma [B.2](https://arxiv.org/html/2511.12456v4#A2.Thmtheorem2 "Lemma B.2. ‣ B.8 Construction of Minorants for (Conditional) Expected Welfare ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information") and F⁡(p)≥F⁡(Vk+1n)=Uk+1nF(p)\\geq F(V^{\\textsc{n}}\_{k+1})=U^{\\textsc{n}}\_{k+1}. The third equality is using 𝔼⁡\[U∣U≥Uk+1n\]=(1+Uk+1n)/2\\mathbb{E}\\left\[U\\mid U\\geq U^{\\textsc{n}}\_{k+1}\\right\]=(1+U^{\\textsc{n}}\_{k+1})/2 for U∼Uniform​\[0,1\]U\\sim\\text{Uniform}\[0,1\], and 𝔼⁡\[Uiq∣Uqq≥Uk+1n\]=(1−Uk+1n)​𝔼​\[Uiq\]+Uk+1n\\mathbb{E}\\left\[U^{q}\_{i}\\mid U^{q}\_{q}\\geq U^{\\textsc{n}}\_{k+1}\\right\]=\\left(1-U^{\\textsc{n}}\_{k+1}\\right)\\mathbb{E}\\left\[U^{q}\_{i}\\right\]+U^{\\textsc{n}}\_{k+1}. The last inequality is because the summation of expected values of uniform order statistics ∑i=1r−k𝔼⁡\[Uiq\]=(r−k)​(2​q−r+k+1)2​(q+1)\\sum\_{i=1}^{r-k}\\mathbb{E}\\left\[U^{q}\_{i}\\right\]={\\scriptscriptstyle(r-k)\\frac{(2q-r+k+1)}{2(q+1)}} when r−k≤qr-k\\leq q. Finally, note that Uk+1n∼Beta​(N−k,k+1)U^{\\textsc{n}}\_{k+1}\\sim\\text{Beta}\\left(N-k,k+1\\right) and is (k+1)−(k+1)-th highest order statistic from NN i.i.d. standard uniform random variables.
∎

Since the utility of all bidders and the auctioneer is non-negative, 𝚆𝚎𝚕C-PoP​(𝖭,𝖢,p)≥𝚁𝚎𝚟C-PoP​(𝖭,𝖢,p)\\mathtt{Wel}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\geq\\mathtt{Rev}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p). Hence, a minorant of the revenue is also a valid minorant of the welfare.

###### Proposition B.4(Minorant of Revenue).

Let Assumptions [4.1](https://arxiv.org/html/2511.12456v4#S4.Thmassumption1 "Assumption 4.1. ‣ 4.3 Expected Welfare Optimization for Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") and [4.2](https://arxiv.org/html/2511.12456v4#S4.Thmassumption2 "Assumption 4.2. ‣ 4.4 Expected Welfare Optimization for Partially-Known Bid Distribution ‣ 4 Designing Truthful Auctions under Collusion ‣ Collusion-Proof Auction Design using Side Information") hold. Then,

|     |     |     |     |
| --- | --- | --- | --- |
|  |  | 𝔼⁡\[𝚁𝚎𝚟C-PoP​(𝖭,𝖢,p)\]≥𝔼⁡\[L​Uk+1𝖭​𝔼​\[wn+∑j=1cmin⁡{j,r−wn}​ℙ​(wc=j)∣Uk+1n\]\]\\displaystyle\\textstyle\\mathbb{E}\\left\[\\mathtt{Rev}\_{\\textsc{C-PoP}}(\\mathsf{N},\\mathsf{C};p)\\right\]\\geq\\mathbb{E}\\big\[LU^{\\mathsf{N}}\_{k+1}\\mathbb{E}\\big\[w\_{\\textsc{n}}+\\sum\_{j=1}^{c}\\min\\{j,r-w\_{\\textsc{n}}\\}\\mathbb{P}\\big(w\_{\\textsc{c}}=j\\big)\\mid U^{\\textsc{n}}\_{k+1}\\big\]\\big\] |  |

where wn∼Binom⁡(k,1−𝖥⁡(p)1−Uk+1n)w\_{\\textsc{n}}\\sim\\mathrm{Binom}\\big(k,\\frac{1-\\mathsf{F}(p)}{1-U^{\\textsc{n}}\_{k+1}}\\big), wc∼Binom⁡(𝖢,1−𝖥⁡(p))w\_{\\textsc{c}}\\sim\\mathrm{Binom}\\big(\\mathsf{C},1-\\mathsf{F}(p)\\big) and Uk+1𝖭∼Beta⁡(n−k,k+1)U^{\\mathsf{N}}\_{k+1}\\sim\\mathrm{Beta}(n-k,k+1).

###### Proof.

The calculations are very similar to Proposition [B.3](https://arxiv.org/html/2511.12456v4#A2.Thmtheorem3 "Proposition B.3 (Minorant of Welfare). ‣ B.8 Construction of Minorants for (Conditional) Expected Welfare ‣ Appendix B Appendix: C-PoP Mechanism ‣ Collusion-Proof Auction Design using Side Information").
∎

## Appendix C Appendix: Numerical Experiments

Simulations were performed on a 2023 MacBook Pro running macOS Sonoma 14.4, with 8GB of unified memory and an Apple M3 chip (8-core CPU). The simulations were implemented in Python 3. Here we display our results for the same distributions and ranges of TT, but now with r=15r=15 items instead of 1010 items.

![Refer to caption](https://arxiv.org/html/2511.12456v4/figures/T_sweep_r=15_alpha=5_beta=3_U_W.png)(a)Welfare (Uniform)

![Refer to caption](https://arxiv.org/html/2511.12456v4/figures/T_sweep_r=15_alpha=5_beta=3_U_R.png)(b)Revenue (Uniform)

![Refer to caption](https://arxiv.org/html/2511.12456v4/figures/T_sweep_r=15_alpha=5_beta=3_E_W.png)(c)Welfare (Exponential)

![Refer to caption](https://arxiv.org/html/2511.12456v4/figures/T_sweep_r=15_alpha=5_beta=3_E_R.png)(d)Revenue (Exponential)

Figure 2: Numerical results for Uniform(0,1) and Exponential (λ\\lambda = 2) distributions where r=15r=15. The solid orange curve is Posted Price with collusion, the dotted light blue curve is VCG with collusion, the long dash-dotted red curve is C-PoP with the firm specific classifier, the medium dash-dotted green curve is C-PoP with the 50/50 classifier, the short dash-dotted blue curve is C-PoP with the random classifier, and the dashed black curve is C-PoP with perfect classification.

The following details the standard errors (SE) and means for all of our experiments. All experiments are conducted using 1000 simulations.

Table 1: Revenue (mean ±\\pm SE) — r=10r=10, Uniform distribution

MechanismT=20T=20T=30T=30T=40T=40T=50T=50T=60T=60T=70T=70T=80T=80T=90T=90T=100T=100T=110T=110VCG w/ Collusion0.17±0.010.17\\pm 0.010.77±0.040.77\\pm 0.041.68±0.051.68\\pm 0.052.68±0.062.68\\pm 0.063.66±0.063.66\\pm 0.064.52±0.064.52\\pm 0.065.15±0.055.15\\pm 0.055.64±0.055.64\\pm 0.056.09±0.046.09\\pm 0.046.44±0.046.44\\pm 0.04Posted Price4.50±0.004.50\\pm 0.005.96±0.005.96\\pm 0.006.78±0.006.78\\pm 0.007.30±0.007.30\\pm 0.007.67±0.007.67\\pm 0.007.95±0.007.95\\pm 0.008.17±0.008.17\\pm 0.008.34±0.008.34\\pm 0.008.48±0.008.48\\pm 0.008.59±0.008.59\\pm 0.00C-PoP (perfect)3.35±0.023.35\\pm 0.025.15±0.025.15\\pm 0.026.18±0.016.18\\pm 0.016.84±0.016.84\\pm 0.017.29±0.017.29\\pm 0.017.62±0.017.62\\pm 0.017.88±0.017.88\\pm 0.018.08±0.018.08\\pm 0.018.25±0.018.25\\pm 0.018.39±0.018.39\\pm 0.01C-PoP (firm size)2.56±0.022.56\\pm 0.024.11±0.024.11\\pm 0.025.25±0.025.25\\pm 0.026.03±0.026.03\\pm 0.026.58±0.026.58\\pm 0.027.00±0.017.00\\pm 0.017.32±0.017.32\\pm 0.017.57±0.017.57\\pm 0.017.80±0.017.80\\pm 0.017.97±0.017.97\\pm 0.01C-PoP (random)2.93±0.032.93\\pm 0.034.71±0.034.71\\pm 0.035.67±0.025.67\\pm 0.026.30±0.016.30\\pm 0.016.78±0.016.78\\pm 0.017.16±0.017.16\\pm 0.017.44±0.007.44\\pm 0.007.67±0.007.67\\pm 0.007.86±0.007.86\\pm 0.008.03±0.008.03\\pm 0.00C-PoP (50/50)2.41±0.022.41\\pm 0.023.65±0.023.65\\pm 0.024.72±0.024.72\\pm 0.025.45±0.025.45\\pm 0.026.07±0.026.07\\pm 0.026.54±0.026.54\\pm 0.026.90±0.016.90\\pm 0.017.21±0.017.21\\pm 0.017.44±0.017.44\\pm 0.017.64±0.017.64\\pm 0.01

Table 2: Welfare (mean ±\\pm SE) — r=10r=10, Uniform distribution

MechanismT=20T=20T=30T=30T=40T=40T=50T=50T=60T=60T=70T=70T=80T=80T=90T=90T=100T=100T=110T=110VCG w/ Collusion7.08±0.027.08\\pm 0.027.62±0.027.62\\pm 0.027.92±0.027.92\\pm 0.028.18±0.028.18\\pm 0.028.44±0.028.44\\pm 0.028.65±0.028.65\\pm 0.028.81±0.018.81\\pm 0.018.93±0.018.93\\pm 0.019.04±0.019.04\\pm 0.019.12±0.019.12\\pm 0.01Posted Price5.95±0.035.95\\pm 0.036.16±0.046.16\\pm 0.046.23±0.046.23\\pm 0.046.07±0.056.07\\pm 0.056.14±0.056.14\\pm 0.056.10±0.056.10\\pm 0.056.03±0.056.03\\pm 0.056.02±0.056.02\\pm 0.056.02±0.066.02\\pm 0.065.95±0.065.95\\pm 0.06C-PoP (perfect)7.31±0.027.31\\pm 0.028.12±0.028.12\\pm 0.028.55±0.028.55\\pm 0.028.82±0.018.82\\pm 0.019.00±0.019.00\\pm 0.019.13±0.019.13\\pm 0.019.23±0.019.23\\pm 0.019.31±0.019.31\\pm 0.019.38±0.019.38\\pm 0.019.43±0.019.43\\pm 0.01C-PoP (firm size)7.13±0.027.13\\pm 0.027.90±0.027.90\\pm 0.028.35±0.028.35\\pm 0.028.65±0.018.65\\pm 0.018.86±0.018.86\\pm 0.019.01±0.019.01\\pm 0.019.12±0.019.12\\pm 0.019.21±0.019.21\\pm 0.019.29±0.019.29\\pm 0.019.34±0.019.34\\pm 0.01C-PoP (random)7.31±0.027.31\\pm 0.028.15±0.028.15\\pm 0.028.57±0.018.57\\pm 0.018.84±0.018.84\\pm 0.019.02±0.019.02\\pm 0.019.15±0.019.15\\pm 0.019.26±0.019.26\\pm 0.019.33±0.019.33\\pm 0.019.40±0.019.40\\pm 0.019.45±0.019.45\\pm 0.01C-PoP (50/50)7.19±0.027.19\\pm 0.027.90±0.027.90\\pm 0.028.33±0.028.33\\pm 0.028.61±0.018.61\\pm 0.018.82±0.018.82\\pm 0.018.97±0.018.97\\pm 0.019.10±0.019.10\\pm 0.019.20±0.019.20\\pm 0.019.27±0.019.27\\pm 0.019.32±0.019.32\\pm 0.01

Table 3: Revenue (mean ±\\pm SE) — r=15r=15, Uniform distribution

MechanismT=20T=20T=30T=30T=40T=40T=50T=50T=60T=60T=70T=70T=80T=80T=90T=90T=100T=100T=110T=110VCG w/ Collusion0.02±0.000.02\\pm 0.000.19±0.010.19\\pm 0.010.66±0.030.66\\pm 0.031.42±0.051.42\\pm 0.052.45±0.072.45\\pm 0.073.60±0.083.60\\pm 0.084.75±0.084.75\\pm 0.085.76±0.085.76\\pm 0.086.60±0.086.60\\pm 0.087.34±0.077.34\\pm 0.07Posted Price3.86±0.003.86\\pm 0.006.89±0.006.89\\pm 0.008.55±0.008.55\\pm 0.009.61±0.009.61\\pm 0.0010.36±0.0010.36\\pm 0.0010.92±0.0010.92\\pm 0.0011.35±0.0011.35\\pm 0.0011.70±0.0011.70\\pm 0.0011.98±0.0011.98\\pm 0.0012.22±0.0012.22\\pm 0.00C-PoP (perfect)2.10±0.012.10\\pm 0.015.42±0.015.42\\pm 0.017.41±0.017.41\\pm 0.018.70±0.018.70\\pm 0.019.60±0.019.60\\pm 0.0110.28±0.0110.28\\pm 0.0110.79±0.0110.79\\pm 0.0111.21±0.0111.21\\pm 0.0111.54±0.0111.54\\pm 0.0111.82±0.0111.82\\pm 0.01C-PoP (firm size)2.05±0.012.05\\pm 0.013.77±0.023.77\\pm 0.025.56±0.035.56\\pm 0.037.07±0.037.07\\pm 0.038.15±0.038.15\\pm 0.038.99±0.028.99\\pm 0.029.63±0.029.63\\pm 0.0210.16±0.0210.16\\pm 0.0210.57±0.0210.57\\pm 0.0210.93±0.0210.93\\pm 0.02C-PoP (random)1.93±0.021.93\\pm 0.025.04±0.025.04\\pm 0.026.83±0.026.83\\pm 0.027.98±0.027.98\\pm 0.028.84±0.018.84\\pm 0.019.51±0.019.51\\pm 0.0110.05±0.0110.05\\pm 0.0110.50±0.0110.50\\pm 0.0110.86±0.0110.86\\pm 0.0111.15±0.0111.15\\pm 0.01C-PoP (50/50)1.98±0.021.98\\pm 0.023.45±0.023.45\\pm 0.024.87±0.024.87\\pm 0.026.17±0.036.17\\pm 0.037.26±0.037.26\\pm 0.038.12±0.028.12\\pm 0.028.80±0.028.80\\pm 0.029.42±0.029.42\\pm 0.029.91±0.029.91\\pm 0.0210.26±0.0210.26\\pm 0.02

Table 4: Welfare (mean ±\\pm SE) — r=15r=15, Uniform distribution

MechanismT=20T=20T=30T=30T=40T=40T=50T=50T=60T=60T=70T=70T=80T=80T=90T=90T=100T=100T=110T=110VCG w/ Collusion9.15±0.039.15\\pm 0.0310.58±0.0310.58\\pm 0.0311.12±0.0311.12\\pm 0.0311.46±0.0311.46\\pm 0.0311.77±0.0311.77\\pm 0.0312.08±0.0312.08\\pm 0.0312.38±0.0212.38\\pm 0.0212.65±0.0212.65\\pm 0.0212.86±0.0212.86\\pm 0.0213.06±0.0213.06\\pm 0.02Posted Price8.09±0.038.09\\pm 0.038.93±0.048.93\\pm 0.049.17±0.059.17\\pm 0.059.19±0.069.19\\pm 0.069.20±0.069.20\\pm 0.069.03±0.079.03\\pm 0.079.03±0.079.03\\pm 0.079.00±0.079.00\\pm 0.078.91±0.078.91\\pm 0.078.83±0.078.83\\pm 0.07C-PoP (perfect)9.21±0.049.21\\pm 0.0411.02±0.0311.02\\pm 0.0311.95±0.0211.95\\pm 0.0212.53±0.0212.53\\pm 0.0212.94±0.0212.94\\pm 0.0213.22±0.0213.22\\pm 0.0213.44±0.0213.44\\pm 0.0213.61±0.0113.61\\pm 0.0113.74±0.0113.74\\pm 0.0113.86±0.0113.86\\pm 0.01C-PoP (firm size)9.17±0.049.17\\pm 0.0410.66±0.0310.66\\pm 0.0311.48±0.0311.48\\pm 0.0312.12±0.0212.12\\pm 0.0212.58±0.0212.58\\pm 0.0212.89±0.0212.89\\pm 0.0213.14±0.0213.14\\pm 0.0213.35±0.0113.35\\pm 0.0113.50±0.0113.50\\pm 0.0113.64±0.0113.64\\pm 0.01C-PoP (random)9.21±0.049.21\\pm 0.0411.01±0.0311.01\\pm 0.0311.94±0.0211.94\\pm 0.0212.53±0.0212.53\\pm 0.0212.93±0.0212.93\\pm 0.0213.20±0.0213.20\\pm 0.0213.42±0.0113.42\\pm 0.0113.60±0.0113.60\\pm 0.0113.73±0.0113.73\\pm 0.0113.85±0.0113.85\\pm 0.01C-PoP (50/50)9.18±0.049.18\\pm 0.0410.73±0.0310.73\\pm 0.0311.50±0.0311.50\\pm 0.0312.04±0.0212.04\\pm 0.0212.49±0.0212.49\\pm 0.0212.80±0.0212.80\\pm 0.0213.04±0.0213.04\\pm 0.0213.26±0.0113.26\\pm 0.0113.43±0.0113.43\\pm 0.0113.56±0.0113.56\\pm 0.01

Table 5: Revenue (mean ±\\pm SE) — r=10r=10, Exponential distribution

MechanismT=20T=20T=30T=30T=40T=40T=50T=50T=60T=60T=70T=70T=80T=80T=90T=90T=100T=100T=110T=110VCG w/ Collusion0.17±0.010.17\\pm 0.010.83±0.030.83\\pm 0.031.75±0.041.75\\pm 0.042.68±0.052.68\\pm 0.053.52±0.053.52\\pm 0.054.24±0.054.24\\pm 0.054.87±0.064.87\\pm 0.065.47±0.065.47\\pm 0.066.01±0.066.01\\pm 0.066.45±0.066.45\\pm 0.06Posted Price3.57±0.003.57\\pm 0.005.31±0.005.31\\pm 0.006.55±0.016.55\\pm 0.017.54±0.017.54\\pm 0.018.36±0.018.36\\pm 0.019.04±0.019.04\\pm 0.019.64±0.019.64\\pm 0.0110.19±0.0110.19\\pm 0.0110.67±0.0110.67\\pm 0.0111.10±0.0211.10\\pm 0.02C-PoP (perfect)2.14±0.012.14\\pm 0.013.85±0.013.85\\pm 0.015.14±0.015.14\\pm 0.016.15±0.016.15\\pm 0.016.95±0.016.95\\pm 0.017.65±0.017.65\\pm 0.018.30±0.018.30\\pm 0.018.85±0.018.85\\pm 0.019.32±0.029.32\\pm 0.029.76±0.029.76\\pm 0.02C-PoP (firm size)2.64±0.012.64\\pm 0.013.76±0.013.76\\pm 0.014.55±0.014.55\\pm 0.015.30±0.025.30\\pm 0.025.98±0.025.98\\pm 0.026.64±0.026.64\\pm 0.027.23±0.027.23\\pm 0.027.78±0.027.78\\pm 0.028.27±0.028.27\\pm 0.028.70±0.038.70\\pm 0.03C-PoP (random)2.01±0.022.01\\pm 0.023.76±0.023.76\\pm 0.025.03±0.025.03\\pm 0.026.03±0.016.03\\pm 0.016.77±0.016.77\\pm 0.017.42±0.017.42\\pm 0.017.95±0.017.95\\pm 0.018.43±0.018.43\\pm 0.018.85±0.018.85\\pm 0.019.22±0.019.22\\pm 0.01C-PoP (50/50)2.63±0.012.63\\pm 0.013.64±0.013.64\\pm 0.014.37±0.014.37\\pm 0.015.00±0.025.00\\pm 0.025.57±0.025.57\\pm 0.026.08±0.026.08\\pm 0.026.58±0.026.58\\pm 0.027.00±0.027.00\\pm 0.027.42±0.027.42\\pm 0.027.83±0.027.83\\pm 0.02

Table 6: Welfare (mean ±\\pm SE) — r=10r=10, Exponential distribution

MechanismT=20T=20T=30T=30T=40T=40T=50T=50T=60T=60T=70T=70T=80T=80T=90T=90T=100T=100T=110T=110VCG w/ Collusion8.13±0.068.13\\pm 0.069.91±0.069.91\\pm 0.0611.22±0.0711.22\\pm 0.0712.27±0.0712.27\\pm 0.0713.14±0.0613.14\\pm 0.0613.87±0.0713.87\\pm 0.0714.52±0.0614.52\\pm 0.0615.10±0.0715.10\\pm 0.0715.62±0.0615.62\\pm 0.0616.13±0.0716.13\\pm 0.07Posted Price6.71±0.056.71\\pm 0.057.78±0.077.78\\pm 0.078.27±0.098.27\\pm 0.098.65±0.108.65\\pm 0.108.86±0.118.86\\pm 0.119.15±0.129.15\\pm 0.129.39±0.139.39\\pm 0.139.62±0.149.62\\pm 0.149.66±0.149.66\\pm 0.149.67±0.159.67\\pm 0.15C-PoP (perfect)8.28±0.068.28\\pm 0.0610.24±0.0610.24\\pm 0.0611.64±0.0711.64\\pm 0.0712.69±0.0712.69\\pm 0.0713.56±0.0713.56\\pm 0.0714.29±0.0714.29\\pm 0.0714.96±0.0714.96\\pm 0.0715.53±0.0715.53\\pm 0.0716.04±0.0716.04\\pm 0.0716.55±0.0716.55\\pm 0.07C-PoP (firm size)8.25±0.068.25\\pm 0.0610.22±0.0610.22\\pm 0.0611.59±0.0611.59\\pm 0.0612.61±0.0612.61\\pm 0.0613.46±0.0613.46\\pm 0.0614.18±0.0614.18\\pm 0.0614.84±0.0614.84\\pm 0.0615.42±0.0615.42\\pm 0.0615.92±0.0615.92\\pm 0.0616.43±0.0616.43\\pm 0.06C-PoP (random)8.27±0.068.27\\pm 0.0610.25±0.0610.25\\pm 0.0611.66±0.0711.66\\pm 0.0712.71±0.0712.71\\pm 0.0713.59±0.0713.59\\pm 0.0714.34±0.0614.34\\pm 0.0615.02±0.0615.02\\pm 0.0615.58±0.0615.58\\pm 0.0616.10±0.0616.10\\pm 0.0616.60±0.0616.60\\pm 0.06C-PoP (50/50)8.25±0.068.25\\pm 0.0610.24±0.0610.24\\pm 0.0611.60±0.0611.60\\pm 0.0612.62±0.0612.62\\pm 0.0613.47±0.0613.47\\pm 0.0614.15±0.0614.15\\pm 0.0614.79±0.0614.79\\pm 0.0615.37±0.0615.37\\pm 0.0615.85±0.0615.85\\pm 0.0616.36±0.0616.36\\pm 0.06

Table 7: Revenue (mean ±\\pm SE) — r=15r=15, Exponential distribution

MechanismT=20T=20T=30T=30T=40T=40T=50T=50T=60T=60T=70T=70T=80T=80T=90T=90T=100T=100T=110T=110VCG w/ Collusion0.02±0.000.02\\pm 0.000.22±0.010.22\\pm 0.010.79±0.030.79\\pm 0.031.64±0.051.64\\pm 0.052.69±0.062.69\\pm 0.063.74±0.063.74\\pm 0.064.73±0.074.73\\pm 0.075.62±0.075.62\\pm 0.076.39±0.076.39\\pm 0.077.13±0.077.13\\pm 0.07Posted Price2.67±0.002.67\\pm 0.005.36±0.005.36\\pm 0.007.25±0.017.25\\pm 0.018.75±0.008.75\\pm 0.009.97±0.009.97\\pm 0.0011.02±0.0011.02\\pm 0.0011.93±0.0011.93\\pm 0.0012.73±0.0012.73\\pm 0.0013.46±0.0013.46\\pm 0.0014.11±0.0014.11\\pm 0.00C-PoP (perfect)1.15±0.011.15\\pm 0.013.54±0.013.54\\pm 0.015.35±0.015.35\\pm 0.016.82±0.016.82\\pm 0.018.02±0.018.02\\pm 0.019.09±0.019.09\\pm 0.019.99±0.019.99\\pm 0.0110.84±0.0110.84\\pm 0.0111.55±0.0111.55\\pm 0.0112.23±0.0112.23\\pm 0.01C-PoP (firm size)1.69±0.011.69\\pm 0.014.06±0.014.06\\pm 0.015.30±0.025.30\\pm 0.026.14±0.026.14\\pm 0.026.89±0.026.89\\pm 0.027.68±0.027.68\\pm 0.028.44±0.028.44\\pm 0.029.15±0.029.15\\pm 0.029.81±0.029.81\\pm 0.0210.46±0.0210.46\\pm 0.02C-PoP (random)1.10±0.011.10\\pm 0.013.46±0.023.46\\pm 0.025.27±0.025.27\\pm 0.026.74±0.026.74\\pm 0.027.99±0.017.99\\pm 0.019.01±0.019.01\\pm 0.019.84±0.019.84\\pm 0.0110.63±0.0110.63\\pm 0.0111.24±0.0111.24\\pm 0.0111.87±0.0111.87\\pm 0.01C-PoP (50/50)1.70±0.011.70\\pm 0.014.05±0.014.05\\pm 0.015.25±0.025.25\\pm 0.026.02±0.026.02\\pm 0.026.70±0.026.70\\pm 0.027.34±0.027.34\\pm 0.027.95±0.027.95\\pm 0.028.50±0.028.50\\pm 0.029.04±0.029.04\\pm 0.029.55±0.029.55\\pm 0.02

Table 8: Welfare (mean ±\\pm SE) — r=15r=15, Exponential distribution

MechanismT=20T=20T=30T=30T=40T=40T=50T=50T=60T=60T=70T=70T=80T=80T=90T=90T=100T=100T=110T=110VCG w/ Collusion9.56±0.079.56\\pm 0.0712.27±0.0812.27\\pm 0.0814.08±0.0814.08\\pm 0.0815.54±0.0815.54\\pm 0.0816.80±0.0816.80\\pm 0.0817.86±0.0817.86\\pm 0.0818.87±0.0818.87\\pm 0.0819.75±0.0819.75\\pm 0.0820.54±0.0820.54\\pm 0.0821.27±0.0821.27\\pm 0.08Posted Price8.39±0.068.39\\pm 0.0610.08±0.0710.08\\pm 0.0710.91±0.0810.91\\pm 0.0811.68±0.1011.68\\pm 0.1012.21±0.1112.21\\pm 0.1112.70±0.1312.70\\pm 0.1312.85±0.1412.85\\pm 0.1413.10±0.1613.10\\pm 0.1613.20±0.1613.20\\pm 0.1613.54±0.1813.54\\pm 0.18C-PoP (perfect)9.60±0.079.60\\pm 0.0712.58±0.0812.58\\pm 0.0814.66±0.0814.66\\pm 0.0816.31±0.0816.31\\pm 0.0817.64±0.0817.64\\pm 0.0818.74±0.0818.74\\pm 0.0819.71±0.0819.71\\pm 0.0820.59±0.0820.59\\pm 0.0821.39±0.0821.39\\pm 0.0822.08±0.0822.08\\pm 0.08C-PoP (firm size)9.57±0.079.57\\pm 0.0712.55±0.0812.55\\pm 0.0814.65±0.0814.65\\pm 0.0816.26±0.0816.26\\pm 0.0817.52±0.0817.52\\pm 0.0818.58±0.0818.58\\pm 0.0819.54±0.0819.54\\pm 0.0820.38±0.0820.38\\pm 0.0821.14±0.0821.14\\pm 0.0821.85±0.0821.85\\pm 0.08C-PoP (random)9.60±0.079.60\\pm 0.0712.57±0.0812.57\\pm 0.0814.67±0.0814.67\\pm 0.0816.31±0.0816.31\\pm 0.0817.65±0.0817.65\\pm 0.0818.75±0.0818.75\\pm 0.0819.73±0.0819.73\\pm 0.0820.61±0.0820.61\\pm 0.0821.40±0.0821.40\\pm 0.0822.09±0.0822.09\\pm 0.08C-PoP (50/50)9.57±0.079.57\\pm 0.0712.55±0.0812.55\\pm 0.0814.66±0.0814.66\\pm 0.0816.28±0.0816.28\\pm 0.0817.55±0.0817.55\\pm 0.0818.57±0.0818.57\\pm 0.0819.52±0.0819.52\\pm 0.0820.34±0.0820.34\\pm 0.0821.11±0.0821.11\\pm 0.0821.76±0.0821.76\\pm 0.08

# coalitional-equilibria-2026

Source: https://arxiv.org/html/2604.28186v1
Fetch status: 200
Retention basis: FetchUrl-rendered Markdown, not original PDF/source bytes.

[Skip to main content](https://arxiv.org/html/2604.28186v1#infobox)

Title:

Content selection saved. Describe the issue below:

Description:

![](https://static.arxiv.org/static/design-system/latest/logos/smileybones.svg)Scheduled maintenance: Wednesday, October 28, 7:00 to 12:00 EDT (11:00 to 16:00 UTC).[Read more on our blog](https://blog.arxiv.org/2026/10/21/scheduled-database-maintenance)Dismiss announcement

[License: CC BY 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2604.28186v1 \[cs.GT\] 30 Apr 2026

# Computing Equilibrium beyond Unilateral Deviation

Mingyang Liu
Affiliation:  LIDS, EECS, Massachusetts Institute of Technology
Affiliation: {liumy19,gfarina,asuman}@mit.eduGabriele Farina
Affiliation:  LIDS, EECS, Massachusetts Institute of Technology
Affiliation: {liumy19,gfarina,asuman}@mit.eduAsuman Ozdaglar
Affiliation:  LIDS, EECS, Massachusetts Institute of Technology
Affiliation: {liumy19,gfarina,asuman}@mit.edu

###### Abstract

Most familiar equilibrium concepts, such as Nash and correlated equilibrium, guarantee only that no single player can improve their utility by deviating unilaterally. They offer no guarantees against profitable coordinated deviations by coalitions. Although the literature proposes solution concepts that provide stability against multilateral deviations ( _e.g._, strong Nash and coalition-proof equilibrium), these generally fail to exist. In this paper, we study an alternative solution concept that minimizes coalitional deviation incentives, rather than requiring them to vanish, and is therefore guaranteed to exist. Specifically, we focus on minimizing the average gain of a deviating coalition, and extend the framework to weighted-average and maximum-within-coalition gains. In contrast, the minimum-gain analogue is shown to be computationally intractable. For the average-gain and maximum-gain objectives, we prove a lower bound on the complexity of computing such an equilibrium and present an algorithm that matches this bound. Finally, we use our framework to solve the _Exploitability Welfare Frontier_ (EWF), the maximum attainable social welfare subject to a given exploitability (the maximum gain over all unilateral deviations).

## 1 Introduction

Most equilibrium concepts studied so far, such as Nash equilibrium (NE) ( [Nash, 1950](https://arxiv.org/html/2604.28186v1#bib.bib34 "")), correlated equilibrium (CE) ( [Aumann, 1974](https://arxiv.org/html/2604.28186v1#bib.bib6 "")), coarse correlated equilibrium (CCE) ( [Moulin and Vial, 1978](https://arxiv.org/html/2604.28186v1#bib.bib33 "")), and Stackelberg equilibrium ( [Von Stackelberg, 2010](https://arxiv.org/html/2604.28186v1#bib.bib45 "")), guarantee only that _no individual player_ has a unilateral utility improving deviation. However, they offer no guarantees when multiple players deviate simultaneously by forming a coalition. In this paper, we address the following question:

> What is an appropriate notion for capturing multilateral deviations, and how can it be computed efficiently?

Previous notions that address coalition deviations, such as strong NE ( [Aumann, 1959](https://arxiv.org/html/2604.28186v1#bib.bib5 ""))111







In this paper, we use the term _strong equilibrium_ to broadly refer to any equilibrium concept that considers multilateral deviations. and coalition-proof equilibrium ( [Bernheim et al., 1987](https://arxiv.org/html/2604.28186v1#bib.bib8 "")), mostly fail to exist in general games (unlike NE). Therefore, instead of searching for a joint strategy immune to all coalition deviations, we focus on computing a joint strategy that _minimizes_ the maximum average gain222







Our framework also extends to coalition objectives based on weighted sums or weighted averages of players’ deviation gains, as well as objectives based on the maximum within-coalition deviation gain. In contrast, the corresponding minimum-gain variant is computationally intractable even for small games. See [6.4](https://arxiv.org/html/2604.28186v1#S6.theoremcounter4 "Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") and [7.5](https://arxiv.org/html/2604.28186v1#S7.theoremcounter5 "Remark 7.5 (Extension to Weighted Sum and Maximum over Coalition Gains). ‣ 7.3 Computation of Equilibrium ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") for details. achievable by any coalition through joint deviation. In other words, we aim to compute the most stable strategy profile, even if a perfectly stable one does not exist. We refer to this notion as the _Minimum Average-Strong Equilibrium_ (MASE).

The difficulty of this optimization problem naturally depends on the complexity of the interactions between players. To formalize this, we introduce the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), 𝒢⁡(𝒱,ℰ)\\mathcal{G}(\\mathcal{V},\\mathcal{E}), where each player is a vertex. An edge connects two players, ii and jj, if and only if there is some player kk whose utility is affected by the actions of both ii and jj. Intuitively, an edge (i,j)\\left(i,j\\right) indicates that the actions of ii and jj jointly influence some player’s utility, and hence that coalitional deviations involving these players can create nontrivial joint effects. The graph 𝒢\\mathcal{G} provides a clear map of the game’s interaction structure, and its properties can help us understand the computational complexity of finding the MASE. For games with simple interaction structures ( _e.g._, a sparse [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")), one might expect to compute the MASE efficiently.

We first show that computing the MASE is computationally challenging in the general case. We establish two key hardness results that delineate the problem’s complexity.

First, the problem is fundamentally harder than finding equilibria like NE or CE. In those cases, we are solving a feasibility problem: finding a strategy where the maximum gain from deviating is at most zero. For MASE, we must solve an optimization problem: minimizing this maximum gain. This distinction is crucial, and we show that even for the simplest case of single-player deviations ( _i.e._, coalitions of size one)333







Restricting to singleton coalitions aligns the deviation model with unilateral deviations, but it still differs from NE: NE only asks whether there exists a feasible solution with deviation gain ≤0\\leq 0, whereas MASE minimizes the deviation gain, approximating the MASE value to within a factor that is inverse polynomial in the number of players is NP-hard. This indicates that even without considering complex coalitions, the problem is intractable without additional assumptions on the game’s structure.

Second, we show that this complexity is intrinsically tied to the structure of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). Building on the strong exponential time hypothesis (SETH) ( [Impagliazzo and Paturi, 2001](https://arxiv.org/html/2604.28186v1#bib.bib27 "")) (see [Theorem6.3](https://arxiv.org/html/2604.28186v1#S6.theoremcounter3 "Theorem 6.3 (Treewidth). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") for details), we prove that solving MASE requires time that is at least exponential in the treewidth444







Treewidth can be thought of as a formal measure of how sparse and ”tree-like” a graph is. of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). This holds even when we only consider coalitions of a constant size. This result demonstrates that the treewidth is a fundamental barrier, and an exponential dependence on it is unavoidable.

Finally, we complement the lower bound with an algorithm whose running time has exponential dependence only on the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), rather than on the number of players. This demonstrates that our hardness result is tight and establishes the treewidth as the definitive parameter characterizing the complexity of computing the MASE. While the problem is hard in general, it becomes tractable for games where the underlying interaction structure is not too complex. The key idea of our algorithm involves breaking the game into small, overlapping, weakly interacting parts, solving the problem locally on each part, and then combining these local solutions consistently.

To summarize, our contributions are as follows:

1. 1.


Complexity characterization. We establish lower bounds on the computational complexity of computing MASE, showing that an exponential dependence on the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is unavoidable ( [Theorem6.3](https://arxiv.org/html/2604.28186v1#S6.theoremcounter3 "Theorem 6.3 (Treewidth). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")). We further show that the minimum-gain variant over coalitions is computationally intractable even for small games ( [Theorem6.4](https://arxiv.org/html/2604.28186v1#S6.theoremcounter4 "Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")).

2. 2.


Algorithmic contribution. We design an algorithm for computing MASE whose running time matches the lower bound in its exponential dependence on the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), rather than depending exponentially on the number of players.

3. 3.


Application to welfare-exploitability tradeoffs. We show how our framework can be used to compute socially optimal strategies subject to a prescribed exploitability budget, thereby characterizing the exploitability welfare frontier ( [Section9](https://arxiv.org/html/2604.28186v1#S9 "9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation")).


#### Technical Overview.

In [Section7](https://arxiv.org/html/2604.28186v1#S7 "7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), we formulate the strong-equilibrium computation problem as a two-player zero-sum meta-game between a correlator and a deviator. The correlator chooses a correlated joint strategy for all players in the original game, whereas the deviator chooses a coalition together with a joint deviation for that coalition. The game is zero-sum because the correlator seeks to minimize the coalition’s gain from deviation, while the deviator seeks to maximize it.

The main computational challenge is that the action spaces of both players in this meta-game are exponentially large: the correlator’s actions are joint action profiles, and the deviator’s actions are coalition-deviation pairs. Standard game-solving approaches, such as no-regret learning ( [Hazan et al., 2016](https://arxiv.org/html/2604.28186v1#bib.bib23 "")) and linear programming ( [Papadimitriou and Roughgarden, 2008](https://arxiv.org/html/2604.28186v1#bib.bib37 "")), typically scale with the largest action space among the players, so applying them directly is computationally intractable. To overcome this obstacle, we instantiate no-regret learning with Follow the Perturbed Leader (FTPL) ( [Hazan et al., 2016](https://arxiv.org/html/2604.28186v1#bib.bib23 "")). Each FTPL update reduces to optimizing a linear objective over the relevant simplex, whose optimum is attained at an extreme point. Thus, it suffices to compute and store a pure strategy at each iteration rather than maintain the full exponential-dimensional distribution.

Finally, we solve the resulting linear optimization oracle via dynamic programming over a tree decomposition of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). This yields a running time that is exponential only in the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), rather than in the number of players. Consequently, the algorithm is efficient for games whose [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") has bounded treewidth. Moreover, its exponential dependence on the treewidth matches the lower bound in [Theorem6.3](https://arxiv.org/html/2604.28186v1#S6.theoremcounter3 "Theorem 6.3 (Treewidth). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").

## 2 Related Work

In this section, we review the literature on strong equilibrium from three perspectives: existence, time complexity, and computation methods.

#### Existence of Strong Equilibrium.

[Aumann (1959)](https://arxiv.org/html/2604.28186v1#bib.bib5 "") introduced the strong NE, where no coalition (a nonempty subset of players) can deviate in a way that strictly improves the utility of all its members. However, even in simple two-player games such as Prisoner’s Dilemma ( [Luce and Raiffa, 1957](https://arxiv.org/html/2604.28186v1#bib.bib32 "")), a strong NE does not exist when players can deviate simultaneously. To address this, [Bernheim et al. (1987)](https://arxiv.org/html/2604.28186v1#bib.bib8 "") proposed the coalition-proof equilibrium, which restricts the set of deviations (see [Section5](https://arxiv.org/html/2604.28186v1#S5 "5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation") for details). Yet, this concept also fails to guarantee existence, already in three-player games ( [Bernheim et al., 1987](https://arxiv.org/html/2604.28186v1#bib.bib8 "")). More recently, [Rahn and Schäfer (2015)](https://arxiv.org/html/2604.28186v1#bib.bib39 "") studied the notion of α\\alpha-approximate kk-equilibrium, where no coalition of size at most kk can deviate so that every member’s utility becomes at least α≥1\\alpha\\geq 1 times their original utility. They further showed that such equilibria exist in graph coordination games only under specific conditions, for instance, when α≥2\\alpha\\geq 2. Motivated by these non-existence results, we instead focus on minimizing the maximum average gain from coalition deviations [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation"), a quantity that is always well defined.

#### Complexity of Strong Equilibrium.

Since a strong NE degenerates to an NE when only singleton coalitions are considered, computing a strong NE is PPAD-hard in general ( [Daskalakis et al., 2009](https://arxiv.org/html/2604.28186v1#bib.bib16 ""); [Chen and Deng, 2006](https://arxiv.org/html/2604.28186v1#bib.bib12 "")). Beyond computation, [Conitzer and Sandholm (2008)](https://arxiv.org/html/2604.28186v1#bib.bib14 "") showed that even deciding whether a strong NE exists is NP-complete in two-player symmetric games, and [Berthelsen and Hansen (2022)](https://arxiv.org/html/2604.28186v1#bib.bib9 "") further established that the problem is ∃ℝ\\mathsf{\\exists\\mathbb{R}}-complete for three-player games. Similarly, [Rahn and Schäfer (2015)](https://arxiv.org/html/2604.28186v1#bib.bib39 "") proved that determining the existence of a strong NE is NP-complete in graph coordination games, even when restricting attention to coalitions of constant size. To the best of our knowledge, however, no hardness results are known for computing strong equilibria when correlation on the joint strategy is allowed, _i.e._, a correlated strategy immune to coalition deviations. In this paper, we show that computing a correlated strategy that minimizes the average gain from coalition deviations is NP-hard. Moreover, we establish a lower bound based on the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), demonstrating an inherent computational barrier in solving the MASE considered here.

#### Computation of Strong Equilibrium.

[Holzman and Law-Yone (1997)](https://arxiv.org/html/2604.28186v1#bib.bib25 "") and [Rozenfeld and Tennenholtz (2006)](https://arxiv.org/html/2604.28186v1#bib.bib41 "") developed algorithms to compute strong NE and correlated strong equilibria in congestion games under certain conditions in polynomial time. [Rahn and Schäfer (2015)](https://arxiv.org/html/2604.28186v1#bib.bib39 "") showed that a strong NE can also be computed in polynomial time when the graph coordination game is defined on a tree. In contrast, [Gatti et al. (2013)](https://arxiv.org/html/2604.28186v1#bib.bib21 "") proposed a spatial branch-and-bound algorithm for computing strong NE more generally, but its runtime is exponential. Along the same lines, [Nessah and Tian (2014)](https://arxiv.org/html/2604.28186v1#bib.bib35 "") also provided a computationally intractable algorithm. Of independent interest, [Papadimitriou and Roughgarden (2008)](https://arxiv.org/html/2604.28186v1#bib.bib37 "") introduced an efficient algorithm for computing optimal CE, _e.g._, a CE that maximizes the social welfare, in graphical games ( [Kearns et al., 2001](https://arxiv.org/html/2604.28186v1#bib.bib30 ""); [Kakade et al., 2003](https://arxiv.org/html/2604.28186v1#bib.bib28 "")) with bounded treewidth, using linear programming. In this paper, we develop a new algorithm for computing MASE based on no-regret learning, with a time complexity that matches the lower bound dictated by the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").

## 3 Preliminaries

For any vector 𝒙∈ℝn\\bm{x}\\in\\mathbb{R}^{n}, we use xix\_{i} to denote its it​hi^{th} element and ‖𝒙‖p\\left\\\|\\bm{x}\\right\\\|\_{p} to denote its pp-norm. By default, ‖𝒙‖\\left\\\|\\bm{x}\\right\\\| refers to the 2-norm. For a positive integer NN, let \[N\]≔1,2,…,N\[N\]\\coloneqq{1,2,\\dots,N}. We denote the (n−1)(n-1)-dimensional probability simplex by Δn≔{𝒙∈\[0,1\]n:∑i=1nxi=1}\\Delta^{n}\\coloneqq\\left\\{\\bm{x}\\in\[0,1\]^{n}\\colon\\sum\_{i=1}^{n}x\_{i}=1\\right\\}. More generally, for any discrete set SS, let \|S\|\\left\|S\\right\| denote its cardinality and write ΔS\\Delta^{S} for the probability simplex over SS, whose coordinates are indexed by elements of SS ( _e.g._, Δn=Δ\[n\]\\Delta^{n}=\\Delta^{\\left\[n\\right\]}). Similarly, ℝS\\mathbb{R}^{S} denotes the \|S\|\\left\|S\\right\|-dimensional real vector space with coordinates indexed by SS. For any set S1,S2S\_{1},S\_{2}, S1×S2S\_{1}\\times S\_{2} denotes the Cartesian product of sets S1S\_{1} and S2S\_{2}. Finally, we let 𝟙(argument)\\ind(\\text{argument}) denote the indicator function, which equals 11 if the argument is true and 00 otherwise.

### 3.1 Games

A game is represented as a tuple (N,{𝒜i}i=1N,{𝒰i}i=1N,𝒮)(N,\\left\\{\\mathcal{A}\_{i}\\right\\}\_{i=1}^{N},\\left\\{\\mathcal{U}\_{i}\\right\\}\_{i=1}^{N},{\\mathcal{S}}), where

- •


NN is the number of players.

- •


𝒜i\\mathcal{A}\_{i} is the action set of player ii. For convenience, let 𝒜≔×i=1N𝒜i\\mathcal{A}\\coloneqq\\bigtimes\_{i=1}^{N}\\mathcal{A}\_{i} denote the joint action set.

- •


𝒰i:𝒜→\[0,1\]\\mathcal{U}\_{i}\\colon\\mathcal{A}\\to\[0,1\] is the utility function of player i∈\[N\]i\\in\[N\].

- •


𝒮{\\mathcal{S}} is the set of coalitions, which is a set of subsets of players. For example, if only unilateral deviations are allowed (as in Nash equilibrium or coarse correlated equilibrium), then 𝒮={{1},{2},…,{N}}{\\mathcal{S}}=\\left\\{\\left\\{1\\right\\},\\left\\{2\\right\\},\\dots,\\left\\{N\\right\\}\\right\\}.


For notational simplicity, for any subset of players S⊆\[N\]S\\subseteq\[N\], we write 𝒜S≔×i∈S𝒜i\\mathcal{A}\_{S}\\coloneqq\\bigtimes\_{i\\in S}\\mathcal{A}\_{i}. Throughout the paper, let A≔maxi∈\[N\]⁡\|𝒜i\|A\\coloneqq\\max\_{i\\in\[N\]}\\left\|\\mathcal{A}\_{i}\\right\| denote the size of the largest action set.

For any joint action 𝒂∈𝒜\\bm{a}\\in\\mathcal{A}, let aia\_{i} denote the action of player ii, and let 𝒂−i=(a1,a2,…,ai−1,ai+1,…​aN)\\bm{a}\_{-i}=(a\_{1},a\_{2},\\dots,a\_{i-1},a\_{i+1},\\dots a\_{N}) be the joint action of all players except ii. More generally, for any subset S⊆\[N\]S\\subseteq\[N\], we write 𝒂−S\\bm{a}\_{-S} for the joint action of players outside SS.

### 3.2 Succinct Representation

This paper focuses on multi-player games with a succinct representation. Specifically, each utility function 𝒰i\\mathcal{U}\_{i} can be encoded using a number of bits polynomial in the number of players NN, rather than requiring 𝒪⁡(N​∏i=1N\|𝒜i\|)\\mathcal{O}\\left(N\\prod\_{i=1}^{N}\|\\mathcal{A}\_{i}\|\\right) bits as in the general case. Examples of succinctly represented games include polymatrix games ( [Howson Jr, 1972](https://arxiv.org/html/2604.28186v1#bib.bib26 ""); [Eaves, 1973](https://arxiv.org/html/2604.28186v1#bib.bib19 "")) and congestion games ( [Rosenthal, 1973](https://arxiv.org/html/2604.28186v1#bib.bib40 "")). Throughout the paper, we call an algorithm _efficient_ if its running time is polynomial in NN, as opposed to polynomial in ∏i=1N\|𝒜i\|\\prod\_{i=1}^{N}\|\\mathcal{A}\_{i}\|. We focus on succinct games because MASE can otherwise be solved by a linear program whose size grows exponentially with NN (see [AppendixA](https://arxiv.org/html/2604.28186v1#A1 "Appendix A Linear Programming for Solving ‣ Computing Equilibrium beyond Unilateral Deviation")). Moreover, the study of strong equilibrium is particularly compelling in large games, where exponential dependence on NN is computationally prohibitive.

## 4 Minimum Average-Strong Equilibrium (MASE)

Several notions of strong equilibrium have been proposed, including the strong Nash equilibrium (NE) ( [Aumann, 1959](https://arxiv.org/html/2604.28186v1#bib.bib5 "")), the sum-strong NE ( [Hoefer, 2013](https://arxiv.org/html/2604.28186v1#bib.bib24 "")) (no improvement on the total gain of any coalition), and coalition-proof equilibrium ( [Bernheim et al., 1987](https://arxiv.org/html/2604.28186v1#bib.bib8 "")) (permits only self-enforcing deviations, see [Section5](https://arxiv.org/html/2604.28186v1#S5 "5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation")). However, none of these notions are guaranteed to exist in general games. To build intuition, we first illustrate why a strong NE does not exist in Prisoner’s Dilemma. Later, we will show that the problem persists even when correlated strategies are allowed.

|     |     |     |
| --- | --- | --- |
|  | Confess (C) | Defect (D) |
| Confess (C) | (0.6,0.6)(0.6,0.6) | (0,1)(0,1) |
| Defect (D) | (1,0)(1,0) | (0.2,0.2)(0.2,0.2) |

Table 1: Utility matrix of Prisoner’s Dilemma. Each entry (a,b)(a,b) denotes the payoff of the row player (aa) and the column player (bb).

###### Lemma 4.1.

In Prisoner’s Dilemma, no strong Nash nor strong correlated equilibrium exists when 𝒮={{1},{2},{1,2}}{\\mathcal{S}}=\\left\\{\\left\\{1\\right\\},\\left\\{2\\right\\},\\left\\{1,2\\right\\}\\right\\} is the set of all non-empty subsets of players.

###### Proof.

Since correlated equilibria include all Nash equilibria, it suffices to examine strong correlated equilibria. A strong correlated equilibrium is a correlated joint strategy where no subset of players (a coalition) can jointly deviate in a way that strictly improves the utility of all its members.

As shown in [Table1](https://arxiv.org/html/2604.28186v1#S4.T1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation"), any strategy with positive weight on (C,C),(C,D),(D,C)(C,C),(C,D),(D,C) yields a profitable deviation for at least one singleton coalition, {1}\\left\\{1\\right\\} or {2}\\left\\{2\\right\\}. Conversely, placing all weight on (D,D)(D,D) creates a deviation to (C,C)(C,C) that benefits the coalition {1,2}\\left\\{1,2\\right\\}. Thus, no strong NE or strong correlated equilibrium exists.∎

In [Lemma5.1](https://arxiv.org/html/2604.28186v1#S5.theoremcounter1 "Lemma 5.1 (Non-existence of Coalition-Proof CCE). ‣ Distinction between coalition-proof and strong CCE. ‣ 5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation"), we further show that even the weaker notion, the coalition-proof equilibrium, may fail to exist in normal-form games, even when correlation is allowed.

The failure of strong equilibria stems from the fact that a single player may belong to multiple coalitions whose objectives are incompatible, so no strategy can simultaneously eliminate profitable deviations for all coalitions. Motivated by this, rather than requiring no profitable deviation exists, we instead look for a joint strategy that _minimizes_ the coalitional incentive to deviate, which always exists by the Weierstrass theorem.

For each coalition S∈𝒮S\\in{\\mathcal{S}}, we adopt a transferable-utility viewpoint: after a deviation, members of SS may redistribute utility internally. Under this assumption, a coalition’s incentive to deviate is naturally summarized by its aggregate gain. To make this notion comparable across coalitions of different sizes, we evaluate it on a per-capita basis by averaging over the players in SS. This motivates the following definition of the _Minimum Average-Strong Equilibrium_ (MASE). Extensions to the weighted sum (average) and to the maximum within-coalition gain are discussed in [Remark7.5](https://arxiv.org/html/2604.28186v1#S7.theoremcounter5 "Remark 7.5 (Extension to Weighted Sum and Maximum over Coalition Gains). ‣ 7.3 Computation of Equilibrium ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). By contrast, extending the criterion to the minimum within-coalition gain is computationally intractable even in small games, as shown in [Theorem6.4](https://arxiv.org/html/2604.28186v1#S6.theoremcounter4 "Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). Let Π⊆Δ𝒜\\Pi\\subseteq\\Delta^{\\mathcal{A}} be the set of joint strategies under consideration. Then a MASE π∗∈Π\\pi^{\*}\\in\\Pi is any solution to

|     |     |     |     |
| --- | --- | --- | --- |
|  | π∗∈argminπ∈ΠmaxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\],\\displaystyle\\pi^{\*}\\in\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Pi}{\\color\[rgb\]{1,0,0}\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]}, |  | (MASE) |

where the  expression above is referred to as the _coalition exploitability_ of π\\pi. To make the solution concept computationally tractable, and to allow coordinated behavior, we work with correlated joint strategies, rather than restricting attention to independent mixed strategies as in NE. Accordingly, throughout the remainder of the paper we take Π=Δ𝒜\\Pi=\\Delta^{\\mathcal{A}}. This choice helps avoid the computational hardness inherited from NE: when the coalition family 𝒮{\\mathcal{S}} contains only singleton coalitions, any strong-equilibrium notion reduces to the usual unilateral-deviation requirement, _i.e._, it collapses to NE. Since computing an NE is PPAD-hard even for two-player normal-form games ( [Chen and Deng, 2006](https://arxiv.org/html/2604.28186v1#bib.bib12 ""); [Daskalakis et al., 2009](https://arxiv.org/html/2604.28186v1#bib.bib16 "")), insisting on an equilibrium notion built on independent strategies would generally be intractable.

Intuitively, [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation") selects the correlated strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}} that minimizes the maximum average gain attainable by any coalition across all possible coalitions. If this value is less than or equal to zero, then no coalition can simultaneously deviate in a way that yields a strictly positive total gain.

A correlated strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}} is called an _ϵ\\epsilon-MASE_ if, for every MASE π∗∈Δ𝒜\\pi^{\*}\\in\\Delta^{\\mathcal{A}},

|     |     |     |     |
| --- | --- | --- | --- |
|  |  | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |
|  | ≤\\displaystyle\\leq | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π∗​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]+ϵ.\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim{\\color\[rgb\]{0.5,0.25,0}\\pi^{\*}}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]+\\epsilon. |  |

A strong Nash equilibrium requires that for any deviating coalition, at least one member does not strictly improve their utility. In contrast, ϵ\\epsilon-MASE aims to minimize the average improvement over all players within any given coalition. From another perspective, ϵ\\epsilon-MASE minimizes the incentive to deviate, even when coalition members can freely reallocate utility within the coalition.

## 5 Relations among Equilibria

In this section, we delineate the relationships among various strong equilibrium concepts, including strong CCE (the counterpart to strong NE ( [Aumann, 1959](https://arxiv.org/html/2604.28186v1#bib.bib5 ""))),555







Here, strong CCE refers to robustness against coalition deviations, analogous to strong NE. This distinguishes it from the definition in [Anagnostides et al. (2022)](https://arxiv.org/html/2604.28186v1#bib.bib2 ""), where ”strong” implies that any unilateral deviation strictly decreases the deviating player’s utility. strictly strong CCE (the counterpart to strictly strong NE ( [van Megen et al., 1996](https://arxiv.org/html/2604.28186v1#bib.bib44 ""))), and coalition-proof CCE (the counterpart to coalition-proof NE ( [Bernheim et al., 1987](https://arxiv.org/html/2604.28186v1#bib.bib8 ""))).

To align with the standard equilibrium requirement that no player or coalition can gain by deviating, we say that a joint strategy π\\pi is a MASE≤0\\text{MASE}^{\\leq 0} if it satisfies666







An ϵ\\epsilon-MASE is an ϵ\\epsilon-approximate minimizer of the coalition exploitability, whereas MASE≤0\\text{MASE}^{\\leq 0} is a joint strategy whose coalition exploitability is at most zero.

|     |     |     |     |
| --- | --- | --- | --- |
|  | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]≤0.\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]\\leq 0. |  | (MASE≤0\\text{MASE}^{\\leq 0}) |

This notion coincides with the sum-strong correlated equilibrium ( [Hoefer, 2013](https://arxiv.org/html/2604.28186v1#bib.bib24 "")) (no improvement on the total gain of any coalition), as the sign of the aggregate deviation gain is invariant to scaling by the coalition size ( _i.e._, the average gain is non-positive if and only if the sum is non-positive).

We can unify these equilibrium notions under a single generalized definition. Note that while standard definitions assume 𝒮{\\mathcal{S}} contains all non-empty subsets of \[N\]\[N\] for strictly strong, strong, and coalition-proof CCE, we generalize 𝒮{\\mathcal{S}} in this work to represent an arbitrary collection of subsets to align with the MASE framework. The unified condition is given by:

|     |     |     |     |
| --- | --- | --- | --- |
|  | maxS∈𝒮⁡maxπ^S∈𝒞S⁡f⁡({𝔼𝒂∼π,𝒂^S∼π^S​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]}i∈S)≤0,\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\pi}\_{S}\\in\\mathcal{C}\_{S}}f\\left(\\left\\{\\mathbb{E}\_{\\bm{a}\\sim\\pi,\\widehat{\\bm{a}}\_{S}\\sim\\widehat{\\pi}\_{S}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]\\right\\}\_{i\\in S}\\right)\\leq 0, |  | (5.1) |

where

|     |     |     |     |
| --- | --- | --- | --- |
|  | (𝒞S,f⁡(G))≔{(Δ𝒜S,1\|G\|​∑g∈Gg)MASE≤0(Δ𝒜S,maxg∈G⁡g−𝟙(ming′∈G⁡g′<0))strictly strong CCE(Δ𝒜S,ming∈G⁡g)strong CCE(self-enforcing strategies,ming∈G⁡g)coalition-proof CCE\\displaystyle(\\mathcal{C}\_{S},f(G))\\coloneqq\\begin{cases}\\left(\\Delta^{\\mathcal{A}\_{S}},\\frac{1}{\|G\|}\\sum\_{g\\in G}g\\right)&\\text{MASE}^{\\leq 0}\\\<br>\\left(\\Delta^{\\mathcal{A}\_{S}},\\max\_{g\\in G}g-\\ind\\left(\\min\_{g^{\\prime}\\in G}g^{\\prime}<0\\right)\\right)&\\text{strictly strong CCE}\\\<br>\\left(\\Delta^{\\mathcal{A}\_{S}},\\min\_{g\\in G}g\\right)&\\text{strong CCE}\\\<br>\\left(\\text{self-enforcing strategies},\\min\_{g\\in G}g\\right)&\\text{coalition-proof CCE}\\end{cases} |  | (5.2) |

The definition of self-enforcing strategies is discussed later in this section. For MASE≤0\\text{MASE}^{\\leq 0}, maximizing over π^S∈Δ𝒜S\\widehat{\\pi}\_{S}\\in\\Delta^{\\mathcal{A}\_{S}} in [5.1](https://arxiv.org/html/2604.28186v1#S5.E1 "In 5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation") is equivalent to maximizing directly over 𝒂^S∈𝒜S\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S} in [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation"). This is because the function ff corresponding to MASE≤0\\text{MASE}^{\\leq 0} is linear in π^S\\widehat{\\pi}\_{S}, so its maximum over the simplex is attained at an extreme point (vertex), _i.e._, at a deterministic choice π^S\\widehat{\\pi}\_{S} with π^S​(𝒂^S)=1\\widehat{\\pi}\_{S}(\\widehat{\\bm{a}}\_{S})=1 for some 𝒂^S∈𝒜S\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}.

For strictly strong CCE, since 𝒰i∈\[0,1\]\\mathcal{U}\_{i}\\in\\left\[0,1\\right\], each gain g∈\[−1,1\]g\\in\\left\[-1,1\\right\], and thus maxg∈G⁡g≤1\\max\_{g\\in G}g\\leq 1. Hence, we have

|     |     |     |     |
| --- | --- | --- | --- |
|  | f⁡(G)≤0if and only ifmaxg∈G⁡g≤0​ or ​ming′∈G​g′<0.\\displaystyle f(G)\\leq 0\\quad\\text{if and only if}\\quad\\max\_{g\\in G}g\\leq 0\\text{ or }\\min\_{g^{\\prime}\\in G}g^{\\prime}<0. |  | (5.3) |

Indeed, if ming′∈G⁡g′<0\\min\_{g^{\\prime}\\in G}g^{\\prime}<0, then f⁡(G)=maxg∈G⁡g−1≤0f(G)=\\max\_{g\\in G}g-1\\leq 0 automatically. Otherwise, ming′∈G⁡g′≥0\\min\_{g^{\\prime}\\in G}g^{\\prime}\\geq 0 and the condition reduces to maxg∈G⁡g≤0\\max\_{g\\in G}g\\leq 0, which forces g≤0g\\leq 0 for all g∈Gg\\in G. Equivalently, f⁡(G)≤0f(G)\\leq 0 fails exactly when ming′∈G⁡g′≥0\\min\_{g^{\\prime}\\in G}g^{\\prime}\\geq 0 and maxg∈G⁡g>0\\max\_{g\\in G}g>0, _i.e._, when a deviation weakly benefits every coalition member and strictly benefits at least one.

#### Distinction between strictly strong and strong CCE.

A strictly strong CCE rules out any coalition deviation that makes all members weakly better off and at least one member strictly better off. A strong CCE rules out any coalition deviation that makes every member strictly better off.

#### Distinction between coalition-proof and strong CCE.

The primary distinction between strong CCE and coalition-proof CCE lies in the set of admissible deviations. For strong CCE, any deviation within Δ𝒜S\\Delta^{\\mathcal{A}\_{S}} is considered feasible.

In contrast, coalition-proof CCE restricts the set of feasible deviations to those that are self-enforcing. Specifically, a deviation is admissible only if it constitutes a coalition-proof equilibrium in the reduced game restricted to players in SS, holding the strategies of players in \[N\]∖S\[N\]\\setminus S fixed at π−S\\pi\_{-S}. Further details are provided in [Bernheim et al. (1987)](https://arxiv.org/html/2604.28186v1#bib.bib8 ""). Consequently, since the set of deviations in coalition-proof CCE is a subset of that in strong CCE, any strong CCE is inherently a coalition-proof CCE. Relations between these strong equilibria are summarized in [Figure1](https://arxiv.org/html/2604.28186v1#S5.F1 "In Distinction between coalition-proof and strong CCE. ‣ 5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation").

In [Lemma5.1](https://arxiv.org/html/2604.28186v1#S5.theoremcounter1 "Lemma 5.1 (Non-existence of Coalition-Proof CCE). ‣ Distinction between coalition-proof and strong CCE. ‣ 5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation"), we extend the non-existence result for (non-correlated) coalition equilibria in [Bernheim et al. (1987)](https://arxiv.org/html/2604.28186v1#bib.bib8 "") to establish the non-existence of coalition-proof CCE, a class that includes all coalition equilibria.

MASE≤0\\text{MASE}^{\\leq 0}(Sum-Strong CCE)Coalition-Proof CCEStrong CCEStrictly Strong CCEFigure 1: The relationship between different strong equilibrium notions.

###### Lemma 5.1(Non-existence of Coalition-Proof CCE).

Coalition-proof CCE may not exist, even in a three-player normal-form game.

The proof is postponed to [AppendixB](https://arxiv.org/html/2604.28186v1#A2 "Appendix B Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation").

The non-existence possibility in [Lemma5.1](https://arxiv.org/html/2604.28186v1#S5.theoremcounter1 "Lemma 5.1 (Non-existence of Coalition-Proof CCE). ‣ Distinction between coalition-proof and strong CCE. ‣ 5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation") automatically implies the non-existence of MASE≤0\\text{MASE}^{\\leq 0}, strictly strong CCE, and strong CCE. This motivates our focus on minimizing the deviation gap rather than seeking a joint strategy that strictly achieves a non-positive deviation gap.

## 6 Hardness of Computing MASE

Recall that we call an algorithm _efficient_ if it runs in time polynomial in NN. In this section, we first establish the computational hardness of computing ϵ\\epsilon-MASE.

###### Theorem 6.1.

Computing ϵ\\epsilon-MASE is NP-hard, even when 𝒮{\\mathcal{S}} only contains singletons (coalitions of size one) and 1/ϵ1/\\epsilon is polynomial in the number of players.

The proof is deferred to [SectionC.1](https://arxiv.org/html/2604.28186v1#A3.SS1 "C.1 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation"). Importantly, [Theorem6.1](https://arxiv.org/html/2604.28186v1#S6.theoremcounter1 "Theorem 6.1. ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") highlights a fundamental distinction from the case of CCE, which can be computed efficiently ( [Papadimitriou and Roughgarden, 2008](https://arxiv.org/html/2604.28186v1#bib.bib37 "")). The reason is that for CCE it suffices to find a correlated strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}} such that the deviation gap, maxi∈\[N\]⁡maxa^i∈𝒜i​𝔼𝒂∼π​\[𝒰i​(a^i,𝒂−i)−𝒰i​(𝒂)\]\\max\_{i\\in\[N\]}\\max\_{\\widehat{a}\_{i}\\in\\mathcal{A}\_{i}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{a}\_{i},\\bm{a}\_{-i}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\], is less or equal to zero, whereas here we must find a strategy that minimizes the gap. Together with the linear programming characterization in [AppendixA](https://arxiv.org/html/2604.28186v1#A1 "Appendix A Linear Programming for Solving ‣ Computing Equilibrium beyond Unilateral Deviation"), this implies that computing ϵ\\epsilon-MASE is actually NP-complete. In fact, [Anagnostides et al. (2025)](https://arxiv.org/html/2604.28186v1#bib.bib3 "") recently showed that even minimizing the _average_ deviation gap of CCE across all players (instead of the maximum gap considered here) is also NP-complete.

### 6.1 Lower Bound on the Exponential Dependence on Treewidth

Next, we present a more refined hardness result: a lower bound for computing MASE. To do so, we first formalize the notion of dependencies among players’ utilities.

For each player i∈\[N\]i\\in\[N\], define the relevant set 𝒩⁡(i)⊆\[N\]\\mathcal{N}(i)\\subseteq\[N\] consisting of all players j∈\[N\]j\\in\[N\] (including j=ij=i) such that the action of jj can affect the utility of ii. Formally, j∈\[N\]j\\in\[N\] is in 𝒩⁡(i)\\mathcal{N}(i) if and only if there exist 𝒂−j∈𝒜−j\\bm{a}\_{-j}\\in\\mathcal{A}\_{-j} and aj,aj′∈𝒜ja\_{j},a\_{j}^{\\prime}\\in\\mathcal{A}\_{j} such that 𝒰i​(aj,𝒂−j)≠𝒰i​(aj′,𝒂−j)\\mathcal{U}\_{i}(a\_{j},\\bm{a}\_{-j})\\not=\\mathcal{U}\_{i}(a\_{j}^{\\prime},\\bm{a}\_{-j}). This leads to the following graph representation.

###### Definition 6.2(Utility Dependency Graph).

1. The utility dependence graph 𝒢=(𝒱,ℰ)\\mathcal{G}=(\\mathcal{V},\\mathcal{E}) is an undirected graph with vertex set 𝒱=\[N\]\\mathcal{V}=\[N\] representing the players, and edge set ℰ=⋃k∈\[N\]{(i,j)\|i,j∈𝒩(k),i≠j}\\mathcal{E}=\\bigcup\_{k\\in\[N\]}\\left\\{(i,j){\\,\|\\,}i,j\\in\\mathcal{N}(k),i\\not=j\\right\\}.


Since 𝒰i\\mathcal{U}\_{i} depends only on the actions of players in 𝒩⁡(i)\\mathcal{N}(i), we may equivalently write 𝒰i​(𝒂C)=𝒰i​(𝒂C,𝒂−C′)\\mathcal{U}\_{i}(\\bm{a}\_{C})=\\mathcal{U}\_{i}(\\bm{a}\_{C},\\bm{a}\_{-C}^{\\prime}) for arbitrary 𝒂−C′∈𝒜−C\\bm{a}\_{-C}^{\\prime}\\in\\mathcal{A}\_{-C}, where C⊇𝒩⁡(i)C\\supseteq\\mathcal{N}(i). It is worth noting that this definition differs from the graph of a graphical game ( [Kakade et al., 2003](https://arxiv.org/html/2604.28186v1#bib.bib28 ""); [Kearns et al., 2001](https://arxiv.org/html/2604.28186v1#bib.bib30 "")). Here, players ii and jj are connected if both influence the utility of some other player kk, even if ii and jj do not directly affect each other. Whereas in graphical games, two players ii and jj are connected if and only if at least one can influence the other’s utility.

With this graph structure in place, we can connect the hardness of computing MASE to the treewidth of 𝒢\\mathcal{G}. Intuitively, treewidth measures how close a graph is to being a tree: the treewidth of 𝒢\\mathcal{G} is one when 𝒢\\mathcal{G} is a tree, and it is N−1N-1 when 𝒢\\mathcal{G} is a complete graph. Throughout this section, let 𝒪∗\\mathcal{O}^{\*} denote asymptotic complexity with factors polynomial in NN suppressed.

###### Theorem 6.3(Treewidth).

Suppose a tree decomposition of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is given. Under the Strong Exponential Time Hypothesis (SETH) ( [Impagliazzo and Paturi, 2001](https://arxiv.org/html/2604.28186v1#bib.bib27 "")),777







SETH assumes that SAT cannot be solved in 𝒪∗​((2−ζ)n)\\mathcal{O}^{\*}((2-\\zeta)^{n}) for any ζ>0\\zeta>0, where nn is the number of variables in the SAT instance. [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation") cannot be computed in 𝒪∗​((A−ζ)tw⁡(𝒢))\\mathcal{O}^{\*}((A-\\zeta)^{{\\rm tw}(\\mathcal{G})}) for any ζ>0\\zeta>0. Moreover, under the additional assumption that BPP=P,888







This assumption implies that any problem with a polynomial-time randomized algorithm also has a polynomial-time deterministic algorithm.19​N2\\frac{1}{9N^{2}}-approximate MASE cannot be computed in 𝒪∗​((A−ζ)tw⁡(𝒢))\\mathcal{O}^{\*}((A-\\zeta)^{{\\rm tw}(\\mathcal{G})}) for any ζ>0\\zeta>0.

The proof is deferred to [SectionC.2](https://arxiv.org/html/2604.28186v1#A3.SS2 "C.2 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation"). For approximate MASEs we assume BPP=P, which is standard in the literature ( [Arora and Barak, 2009](https://arxiv.org/html/2604.28186v1#bib.bib4 "")), because the reduction involves sampling joint actions from the approximate MASE. Since enumerating all 𝒂∈𝒜\\bm{a}\\in\\mathcal{A} is computationally infeasible, we rely on randomized sampling. This yields only a randomized algorithm for the original NP-hard problem, and the assumption BPP=P ensures that such a randomized algorithm can be derandomized into a deterministic one, completing the reduction. Finally, we note that the argument can be extended to the maximum-within-coalition variant, showing that its computation also requires exponential dependence on the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").

[Theorem6.3](https://arxiv.org/html/2604.28186v1#S6.theoremcounter3 "Theorem 6.3 (Treewidth). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") shows that the computational complexity of solving MASE is inherently tied to the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). Intuitively, when the treewidth is large, each player’s utility depends on many others, making even the evaluation of coalition deviations computationally demanding (enumerating over all 𝒂^S∈𝒜S\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}). In contrast, when the treewidth is small, such as zero (each player’s utility depends only on their own action), computing MASE becomes trivial, since each player’s utility can be maximized independently. In polymatrix games ( [Eaves, 1973](https://arxiv.org/html/2604.28186v1#bib.bib19 "")), the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") can be bounded by that of its corresponding graph. Further details are provided in [AppendixI](https://arxiv.org/html/2604.28186v1#A9 "Appendix I Polymatrix Games ‣ Computing Equilibrium beyond Unilateral Deviation").

Furthermore, we show that the minimum-value analogue of strong CCE is NP-hard to approximate, even in small games whose joint action space is only polynomial in the number of players and the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is two.

###### Theorem 6.4.

Approximating

|     |     |     |     |
| --- | --- | --- | --- |
|  | minπ∈Δ𝒜⁡maxS∈𝒮​maxπ^S∈Δ𝒜S​mini∈S​𝔼𝒂∼π,𝒂^S∼π^S​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\min\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\pi}\_{S}\\in\\Delta^{\\mathcal{A}\_{S}}}\\min\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi,\\widehat{\\bm{a}}\_{S}\\sim\\widehat{\\pi}\_{S}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  | (Minimum Strong CCE) |

within an additive error of 1N2\\frac{1}{N^{2}} is NP-hard, even for a small game in which the joint action set size \|𝒜\|\|\\mathcal{A}\| is polynomial in the number of players NN and the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is two.

The proof is deferred to [SectionC.3](https://arxiv.org/html/2604.28186v1#A3.SS3 "C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation"). [Theorem6.4](https://arxiv.org/html/2604.28186v1#S6.theoremcounter4 "Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") shows that computing [Minimum Strong CCE](https://arxiv.org/html/2604.28186v1#S6.Ex1 "In Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is intractable unless 𝖯=𝖭𝖯{\\sf P}={\\sf NP}. Accordingly, throughout the remainder of the paper, we focus on aggregation rules based on the (weighted) average and the maximum deviation gain.

###### Remark 6.5.

The hard instance in [Theorem6.1](https://arxiv.org/html/2604.28186v1#S6.theoremcounter1 "Theorem 6.1. ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") has a joint action set whose size is exponential in the number of players, whereas the instance in [Theorem6.4](https://arxiv.org/html/2604.28186v1#S6.theoremcounter4 "Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") does not. This distinction is important: by the linear-programming formulation in [AppendixA](https://arxiv.org/html/2604.28186v1#A1 "Appendix A Linear Programming for Solving ‣ Computing Equilibrium beyond Unilateral Deviation"), MASE can be computed in time polynomial in \|𝒜\|\|\\mathcal{A}\| for any finite game. In contrast, [Theorem6.4](https://arxiv.org/html/2604.28186v1#S6.theoremcounter4 "Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") rules out even an approximation algorithm whose running time is polynomial in \|𝒜\|\|\\mathcal{A}\| for [Minimum Strong CCE](https://arxiv.org/html/2604.28186v1#S6.Ex1 "In Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), unless 𝖯=𝖭𝖯{\\sf P}={\\sf NP}. Therefore, this hardness cannot be attributed to the size of the joint action space. Rather, it stems from the intrinsic min-max-min structure of the minimum strong CCE objective.

## 7 Efficient Computation of MASE

Although an [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation") lives in an exponentially large space (of size \|𝒜\|\|\\mathcal{A}\|), it can still be computed efficiently. This is because the equilibrium always admits a compact representation.

###### Theorem 7.1(Efficient Representation).

For any ϵ≥0\\epsilon\\geq 0, at least one of the ϵ\\epsilon-MASE can be represented as a linear combination of ∑S∈𝒮\|S\|⋅Atw⁡(𝒢)+1\\sum\_{S\\in{\\mathcal{S}}}\|S\|\\cdot A^{{\\rm tw}(\\mathcal{G})}+1 pure strategies, where tw⁡(𝒢){\\rm tw}(\\mathcal{G}) is the treewidth of [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").

The proof is deferred to [AppendixD](https://arxiv.org/html/2604.28186v1#A4 "Appendix D Proof of ‣ Computing Equilibrium beyond Unilateral Deviation"). Intuitively, [Theorem7.1](https://arxiv.org/html/2604.28186v1#S7.theoremcounter1 "Theorem 7.1 (Efficient Representation). ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") shows that there must be an ϵ\\epsilon-MASE that always has a sparse representation. Since each pure strategy can be encoded by the corresponding joint action rather than by a full vector in Δ𝒜\\Delta^{\\mathcal{A}}, this sparsity provides a structural explanation for why efficient computation is possible. We emphasize, however, that [Theorem7.1](https://arxiv.org/html/2604.28186v1#S7.theoremcounter1 "Theorem 7.1 (Efficient Representation). ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is not used as a subroutine in the algorithm developed below. Rather, it serves as intuition for the compactness that the algorithm exploits.

### 7.1 Meta-Game between the Correlator and Deviator

To compute an [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation"), we reformulate the problem as a _meta-game_ between two players: the _correlator_ and the _deviator_( [Hart and Schmeidler, 1989](https://arxiv.org/html/2604.28186v1#bib.bib22 "")). The correlator chooses the correlated strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}}, while the deviator selects deviations. The game is zero-sum: the correlator aims to minimize the coalition’s gain from deviation, and the deviator aims to maximize it. Formally:

|     |     |     |     |
| --- | --- | --- | --- |
|  | minπ∈Δ𝒜maxμ∈Δ×S∈𝒮𝒜SF(π,μ),\\displaystyle\\min\_{\\pi\\in\\Delta^{\\mathcal{A}}}~\\max\_{\\mu\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}}~F(\\pi,\\mu), |  | (7.1) |

where

|     |     |     |     |
| --- | --- | --- | --- |
|  | F⁡(π,μ)≔∑S∈𝒮∑𝒂^S∈𝒜Sμ⁡(S,𝒂^S)\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\].\\displaystyle F(\\pi,\\mu)\\coloneqq\\sum\_{S\\in{\\mathcal{S}}}\\sum\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{\\mu(S,\\widehat{\\bm{a}}\_{S})}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]. |  | (7.2) |

Here, we extend the deviator’s decision space from a discrete to a continuous set. This relaxation does not strengthen the deviator, since the objective is linear in μ\\mu, and the maximum is always attained at an extreme point. Therefore, [7.1](https://arxiv.org/html/2604.28186v1#S7.E1 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is equivalent to the original definition in [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation").

A natural idea is to apply no-regret learning algorithms simultaneously for the correlator and deviator. However, directly updating the full distributions π\\pi and μ\\mu is infeasible, because the underlying spaces are exponentially large.

Fortunately, [Theorem7.1](https://arxiv.org/html/2604.28186v1#S7.theoremcounter1 "Theorem 7.1 (Efficient Representation). ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") implies that maintaining the full distributions is unnecessary: it suffices to keep track of a polynomial number of pure strategies, and use their convex combination as the approximate equilibrium. This motivates our use of _Follow the Perturbed Leader_ (FTPL) ( [Hazan et al., 2016](https://arxiv.org/html/2604.28186v1#bib.bib23 "")), where each decision at a timestep is a pure strategy, which can be represented compactly.

Let π(t)∈Δ𝒜\\pi^{(t)}\\in\\Delta^{\\mathcal{A}} and μ(t)∈Δ×S∈𝒮𝒜S\\mu^{(t)}\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}} denote the decision variables at timestep t≥1t\\geq 1 for the correlator and the deviator, respectively. The interaction between these two players can be described by the update rule

|     |     |     |     |
| --- | --- | --- | --- |
|  | π(t+1)∈argminπ∈Δ𝒜∑τ=1tF⁡(π,μ(τ))−⟨𝒏~(t+1),π⟩μ(t+1)∈argmaxμ(t)∈Δ×S∈𝒮𝒜S∑τ=1tF(π(τ),μ)+⟨𝒎~(t+1),μ⟩,\\begin{split}&\\pi^{(t+1)}\\in\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\sum\_{\\tau=1}^{t}F\\left(\\pi,\\mu^{(\\tau)}\\right)-\\left\\langle\\widetilde{\\bm{n}}^{(t+1)},\\pi\\right\\rangle\\\<br>&\\mu^{(t+1)}\\in\\mathop{\\mathrm{argmax}}\_{\\mu^{(t)}\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}}~\\sum\_{\\tau=1}^{t}F\\left(\\pi^{(\\tau)},\\mu\\right)+\\left\\langle\\widetilde{\\bm{m}}^{(t+1)},\\mu\\right\\rangle,\\end{split} |  | (7.3) |

where 𝒏~(t+1)\\widetilde{\\bm{n}}^{(t+1)} and 𝒎~(t+1)\\widetilde{\\bm{m}}^{(t+1)} are noise vectors sampled independently at each timestep from some distribution, which we will specify later. These noise terms play the role of regularizers in online mirror descent (OMD) ( [Hazan et al., 2016](https://arxiv.org/html/2604.28186v1#bib.bib23 "")), ensuring stability in the updates by controlling 𝔼⁡\[‖π(t+1)−π(t)‖\]\\mathbb{E}\\left\[\\left\\\|\\pi^{(t+1)}-\\pi^{(t)}\\right\\\|\\right\] and 𝔼⁡\[‖μ(t+1)−μ(t)‖\]\\mathbb{E}\\left\[\\left\\\|\\mu^{(t+1)}-\\mu^{(t)}\\right\\\|\\right\].

Since F⁡(π,μ)F(\\pi,\\mu) is bilinear in (π,μ)(\\pi,\\mu), both the minimization and maximization problems admit solutions at vertices of their respective decision spaces. In other words, the argmin\\mathop{\\mathrm{argmin}} for the correlator and the argmax\\mathop{\\mathrm{argmax}} for the deviator always contain at least one pure strategy.

In what follows, we will explain in detail how to update π\\pi efficiently under this framework. The update of μ\\mu is deferred to [AppendixG](https://arxiv.org/html/2604.28186v1#A7 "Appendix G Efficient Update of 𝜇 ‣ Computing Equilibrium beyond Unilateral Deviation").

### 7.2 Efficient Update of π\\pi

The key step in updating π(t+1)\\pi^{(t+1)} is to select a pure strategy, _i.e._, a joint action 𝒂(t+1)∈𝒜\\bm{a}^{(t+1)}\\in\\mathcal{A} with π(t+1)​(𝒂(t+1))=1\\pi^{(t+1)}(\\bm{a}^{(t+1)})=1, that minimizes the objective. To gain insight into this update rule, we first examine how to compute argminπ∈Δ𝒜F⁡(π,μ)\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}F(\\pi,\\mu) for a fixed μ\\mu.

Suppose we want to find a joint action 𝒂~∈𝒜\\widetilde{\\bm{a}}\\in\\mathcal{A} such that the pure strategy π~\\widetilde{\\pi} with π~​(𝒂~)=1\\widetilde{\\pi}(\\widetilde{\\bm{a}})=1 minimizes F⁡(π~,μ)F(\\widetilde{\\pi},\\mu). Expanding the definition, we obtain

|     |     |     |     |
| --- | --- | --- | --- |
|  | F⁡(π~,μ)=\\displaystyle F(\\widetilde{\\pi},\\mu)= | ∑i=1N∑S∈𝒮:i∈S∑𝒂^S∈𝒜Sμ⁡(S,𝒂^S)\|S\|(𝒰i(𝒂^S,𝒂~−S)−𝒰i(𝒂~))\\displaystyle\\sum\_{i=1}^{N}~\\sum\_{S\\in{\\mathcal{S}}\\colon i\\in S}~\\sum\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{\\mu(S,\\widehat{\\bm{a}}\_{S})}{\|S\|}\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\widetilde{\\bm{a}}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\widetilde{\\bm{a}}\\right)\\right) |  |
|  | =\\displaystyle= | ∑i=1N∑S∈𝒮:i∈S∑𝒂^S∈𝒜Sμ⁡(S,𝒂^S)\|S\|(𝒰i(𝒂^S∩𝒩⁡(i),𝒂~𝒩⁡(i)∖S)−𝒰i(𝒂~𝒩⁡(i))).\\displaystyle\\sum\_{i=1}^{N}~{\\color\[rgb\]{1,0,0}\\sum\_{S\\in{\\mathcal{S}}\\colon i\\in S}~\\sum\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{\\mu(S,\\widehat{\\bm{a}}\_{S})}{\|S\|}\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S\\cap\\mathcal{N}(i)},\\widetilde{\\bm{a}}\_{\\mathcal{N}(i)\\setminus S}\\right)-\\mathcal{U}\_{i}\\left(\\widetilde{\\bm{a}}\_{\\mathcal{N}(i)}\\right)\\right)}. |  |

Therefore, for each candidate 𝒂~∈𝒜\\widetilde{\\bm{a}}\\in\\mathcal{A}, only the local actions 𝒂~𝒩⁡(i)\\widetilde{\\bm{a}}\_{\\mathcal{N}(i)} matter for the  expression above. If we can evaluate this  expression efficiently,999







This is possible since μ\\mu is a linear combination of pure strategies when updated according to [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). then for each player i∈\[N\]i\\in\[N\] we may search for 𝒂~𝒩⁡(i)\\widetilde{\\bm{a}}\_{\\mathcal{N}(i)} that minimizes it. However, a difficulty arises because 𝒩⁡(i)\\mathcal{N}(i) and 𝒩⁡(j)\\mathcal{N}(j) may overlap across different players. Hence, we must ensure that the local assignments remain globally consistent.

To address this, we now introduce the concept of a tree decomposition and show how it enables us to optimize FF efficiently. Throughout the paper, we assume that a tree decomposition is given, and analyze the complexity only with respect to this decomposition.

Figure 2: An illustration of a tree decomposition of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").

#### Tree decomposition.

A tree decomposition 𝒯≔{B1,B2,…,BK}{\\mathcal{T}}\\coloneqq\\left\\{B^{1},B^{2},\\dots,B^{K}\\right\\} of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") 𝒢=(𝒱,ℰ)\\mathcal{G}=(\\mathcal{V},\\mathcal{E}) is a tree with KK nodes (bags), each Bk⊆𝒱B^{k}\\subseteq\\mathcal{V} where 𝒱=\[N\]\\mathcal{V}=\[N\], satisfying the following properties ( [Diestel, 2025](https://arxiv.org/html/2604.28186v1#bib.bib18 "")):

1. Property 1 of Tree Decomposition.


⋃k=1KBk=\[N\]\\bigcup\_{k=1}^{K}B^{k}=\[N\].

2. Property 2 of Tree Decomposition.


For every edge (i,j)∈ℰ(i,j)\\in\\mathcal{E}, there exists kk with {i,j}⊆Bk\\left\\{i,j\\right\\}\\subseteq B^{k}.

3. Property 3 of Tree Decomposition.


For any player i∈\[N\]i\\in\[N\], if ii appears in two bags B,B′∈𝒯B,B^{\\prime}\\in{\\mathcal{T}}, then every bag on the path from BB to B′B^{\\prime} also contains ii.


The treewidth of 𝒢\\mathcal{G} is

|     |     |     |     |
| --- | --- | --- | --- |
|  | tw⁡(𝒢)≔min𝒯⁡maxB∈𝒯⁡(\|B\|−1),\\displaystyle{\\rm tw}(\\mathcal{G})\\coloneqq\\min\_{{\\mathcal{T}}}\\max\_{B\\in{\\mathcal{T}}}\\left(\|B\|-1\\right), |  | (7.4) |

that is, the minimum, over all tree decompositions, of the maximum bag size minus one. As illustrated in [Figure2](https://arxiv.org/html/2604.28186v1#S7.F2 "In 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), the tree decomposition separates the game into overlapping bags. For example, since B2B^{2} and B3B^{3} only overlap at B1B^{1}, then B2B^{2} and B3B^{3} can be optimized independently, with consistency later enforced at B1B^{1}.

As illustrated in [Figure2](https://arxiv.org/html/2604.28186v1#S7.F2 "In 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), a tree decomposition separates the game into overlapping local components. For example, if the subtrees rooted at B2B^{2} and B3B^{3} intersect only through B1B^{1}, then the assignments within these two subtrees can be optimized independently once their shared actions on B1B^{1} are fixed; global consistency is subsequently enforced through the overlaps between adjacent bags.

Since any clique in 𝒢\\mathcal{G} is contained in some bag ( [Diestel, 2025](https://arxiv.org/html/2604.28186v1#bib.bib18 "")), for every player i∈\[N\]i\\in\[N\] there exists a bag BB with 𝒩⁡(i)⊆B\\mathcal{N}(i)\\subseteq B. We arbitrarily assign each player ii to such a bag.

#### Dynamic programming on the tree.

We begin by choosing an arbitrary bag as the root of the tree decomposition and denote it by BrB^{r}. For each bag B∈𝒯B\\in{\\mathcal{T}}, let C⁡(B)C(B) denote the set of its children. With this setup, we maintain a vector 𝒅(t+1)∈ℝ×B∈𝒯𝒜B\\bm{d}^{(t+1)}\\in\\mathbb{R}^{\\bigtimes\_{B\\in{\\mathcal{T}}}\\mathcal{A}\_{B}}, defined as

|     |     |     |     |
| --- | --- | --- | --- |
|  | d(t+1)​(B,𝒂B)=∑τ=1t∑S∈𝒮1\|S\|∑i∈S:i​ assigned to ​B∑𝒂^S∈𝒜Sμ(τ)(S,𝒂^S)(𝒰i((𝒂^S∩B,𝒂B∖S))−𝒰i(𝒂B))+∑B′∈C⁡(B)min𝒂B′′∈𝒜B′:𝒂B∩B′=𝒂B∩B′′d(t+1)(B′,𝒂B′′)−n(t+1)(B,𝒂B),\\begin{split}d^{(t+1)}(B,\\bm{a}\_{B})=&\\sum\_{\\tau=1}^{t}\\sum\_{S\\in{\\mathcal{S}}}\\frac{1}{\|S\|}\\sum\_{\\begin{subarray}{c}i\\in S\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}{\\color\[rgb\]{0,0,1}\\sum\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}}\\mu^{(\\tau)}\\left(S,\\widehat{\\bm{a}}\_{S}\\right)\\left(\\mathcal{U}\_{i}\\left((\\widehat{\\bm{a}}\_{S\\cap B},\\bm{a}\_{B\\setminus S})\\right)-\\mathcal{U}\_{i}(\\bm{a}\_{B})\\right)\\\<br>&+\\sum\_{B^{\\prime}\\in C(B)}\\min\_{\\begin{subarray}{c}\\bm{a}\_{B^{\\prime}}^{\\prime}\\in\\mathcal{A}\_{B^{\\prime}}\\colon\\\<br>\\bm{a}\_{B\\cap B^{\\prime}}=\\bm{a}^{\\prime}\_{B\\cap B^{\\prime}}\\end{subarray}}d^{(t+1)}(B^{\\prime},\\bm{a}\_{B^{\\prime}}^{\\prime})-n^{(t+1)}(B,\\bm{a}\_{B}),\\end{split} |  | (7.5) |

where n(t+1)​(B,𝒂B)∼Exp⁡(η)n^{(t+1)}(B,\\bm{a}\_{B})\\sim{\\rm Exp}\\left(\\eta\\right)101010Pr⁡(x≥w)=exp⁡(−η​w)\\Pr(x\\geq w)=\\exp(-\\eta w) when x∼Exp⁡(η)x\\sim{\\rm Exp}\\left(\\eta\\right). is sampled from an exponential distribution. Therefore, in [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), n~(t+1)​(𝒂)=∑B∈𝒯n(t+1)​(B,𝒂B)\\widetilde{n}^{(t+1)}(\\bm{a})=\\sum\_{B\\in{\\mathcal{T}}}n^{(t+1)}(B,\\bm{a}\_{B}).
Since each ii assigned to BB satisfies 𝒩⁡(i)⊆B\\mathcal{N}(i)\\subseteq B, the utility 𝒰i​(𝒂B)\\mathcal{U}\_{i}(\\bm{a}\_{B}) can be written in terms of 𝒂B\\bm{a}\_{B} alone. Moreover, the summation ∑𝒂^S∈𝒜S{\\color\[rgb\]{0,0,1}\\sum\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}} can be computed efficiently, since μ(τ)\\mu^{(\\tau)} is updated via [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") and is therefore a pure strategy.

#### Reconstructing the strategy.

The optimal joint action 𝒂(t+1)∈𝒜\\bm{a}^{(t+1)}\\in\\mathcal{A} is then reconstructed recursively from the root BrB^{r} to the leaves:

|     |     |     |     |
| --- | --- | --- | --- |
|  | 𝒂Br(t+1)=argmin𝒂Br∈𝒜Brd(t+1)​(Br,𝒂Br)∀B∈C⁡(Br),𝒂B∖Br(t+1)=argmin𝒂B∖Br∈𝒜B∖Brd(t+1)​(B,(𝒂B∖Br,𝒂B∩Br(t+1))).\\begin{split}&\\bm{a}\_{B^{r}}^{(t+1)}=\\mathop{\\mathrm{argmin}}\_{\\bm{a}\_{B^{r}}\\in\\mathcal{A}\_{B^{r}}}d^{(t+1)}(B^{r},\\bm{a}\_{B^{r}})\\\<br>\\forall B\\in C(B^{r}),~~~&\\bm{a}\_{B\\setminus B^{r}}^{(t+1)}=\\mathop{\\mathrm{argmin}}\_{{\\color\[rgb\]{0,0.5,0}\\bm{a}\_{B\\setminus B^{r}}\\in\\mathcal{A}\_{B\\setminus B^{r}}}}d^{(t+1)}\\left(B,(\\bm{a}\_{B\\setminus B^{r}},\\bm{a}^{(t+1)}\_{B\\cap B^{r}})\\right).\\end{split} |  | (7.6) |

By [Property 1 of Tree Decomposition](https://arxiv.org/html/2604.28186v1#S7.I1.i1 "In Tree decomposition. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), every player’s action will be included. Since argmin𝒂B∖Br∈𝒜B∖Br\\mathop{\\mathrm{argmin}}\_{{\\color\[rgb\]{0,0.5,0}\\bm{a}\_{B\\setminus B^{r}}\\in\\mathcal{A}\_{B\\setminus B^{r}}}} is taken over 𝒜B∖Br\\mathcal{A}\_{B\\setminus B^{r}}, no contradictions arise by [Property 3 of Tree Decomposition](https://arxiv.org/html/2604.28186v1#S7.I1.i3 "In Tree decomposition. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). We then set π(t+1)​(𝒂(t+1))=1\\pi^{(t+1)}(\\bm{a}^{(t+1)})=1.

The regret bound of this procedure is summarized below.

###### Theorem 7.2.

Consider [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). For any δ>0\\delta>0, with probability at least 1−δ1-\\delta, the following holds:

|     |     |     |
| --- | --- | --- |
|  | max⁡∑t=1Tπ^∈Δ𝒜⁡F⁡(π(t),μ(t))−F⁡(π^,μ(t))≤2​\|𝒯\|​1+(tw⁡(𝒢)+1)​log⁡Aη+2​η​\|𝒯\|​T+2​T​log⁡1δ.\\displaystyle\\max\_{\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}}\\sum\_{t=1}^{T}F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(t)}\\right)\\leq 2\\left\|{\\mathcal{T}}\\right\|\\frac{1+\\left({\\rm tw}(\\mathcal{G})+1\\right)\\log A}{\\eta}+2\\eta\\left\|{\\mathcal{T}}\\right\|T+\\sqrt{2T\\log\\frac{1}{\\delta}}. |  |

The proof is given in [AppendixF](https://arxiv.org/html/2604.28186v1#A6 "Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation"). Importantly, [Theorem7.2](https://arxiv.org/html/2604.28186v1#S7.theoremcounter2 "Theorem 7.2. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") shows that by setting η=1/T\\eta=1/\\sqrt{T}, we obtain 𝒪⁡(T)\\mathcal{O}(\\sqrt{T}) regret. Since the update rule for μ\\mu mirrors that of π\\pi, the detailed analysis is deferred to [AppendixG](https://arxiv.org/html/2604.28186v1#A7 "Appendix G Efficient Update of 𝜇 ‣ Computing Equilibrium beyond Unilateral Deviation"). We now formally state the regret bound for μ\\mu in the following theorem.

###### Theorem 7.3.

Consider the updates in [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). For any δ>0\\delta>0, with probability at least 1−δ1-\\delta, the following holds:

|     |     |     |     |
| --- | --- | --- | --- |
|  | maxμ^∈Δ×S∈𝒮𝒜S∑t=1TF(π(t),μ^)−F(π(t),μ(t))≤\\displaystyle\\max\_{\\widehat{\\mu}\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}}\\sum\_{t=1}^{T}F\\left(\\pi^{(t)},\\widehat{\\mu}\\right)-F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\leq | 2​\|𝒯\|​1+(tw⁡(𝒢)+1)​log⁡Aη+2​η​\|𝒯\|​T+2​T​log⁡1δ.\\displaystyle 2\\left\|{\\mathcal{T}}\\right\|\\frac{1+\\left({\\rm tw}(\\mathcal{G})+1\\right)\\log A}{\\eta}+2\\eta\\left\|{\\mathcal{T}}\\right\|T+\\sqrt{2T\\log\\frac{1}{\\delta}}. |  |

The complete proof is provided in [AppendixG](https://arxiv.org/html/2604.28186v1#A7 "Appendix G Efficient Update of 𝜇 ‣ Computing Equilibrium beyond Unilateral Deviation").

### 7.3 Computation of Equilibrium

For any δ′>0\\delta^{\\prime}>0, by setting δ=δ′2\\delta=\\frac{\\delta^{\\prime}}{2} in [Theorem7.2](https://arxiv.org/html/2604.28186v1#S7.theoremcounter2 "Theorem 7.2. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") and [Theorem7.3](https://arxiv.org/html/2604.28186v1#S7.theoremcounter3 "Theorem 7.3. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), and applying the union bound, we obtain that with probability at least 1−δ′1-\\delta^{\\prime}, the following holds:

|     |     |     |     |
| --- | --- | --- | --- |
|  | maxμ^∈Δ×S∈𝒮𝒜S∑t=1TF(π(t),μ)−minπ^∈Δ𝒜∑t=1TF(π^,μ(t))≤4​\|𝒯\|​1+(tw⁡(𝒢)+1)​log⁡Aη+4​η​\|𝒯\|​T+2​2​T​log⁡2δ′.\\begin{split}&\\max\_{\\widehat{\\mu}\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}}\\sum\_{t=1}^{T}F\\left(\\pi^{(t)},\\mu\\right)-\\min\_{\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}}\\sum\_{t=1}^{T}F\\left(\\widehat{\\pi},\\mu^{(t)}\\right)\\\<br>\\leq&4\\left\|{\\mathcal{T}}\\right\|\\frac{1+\\left({\\rm tw}(\\mathcal{G})+1\\right)\\log A}{\\eta}+4\\eta\\left\|{\\mathcal{T}}\\right\|T+2\\sqrt{2T\\log\\frac{2}{\\delta^{\\prime}}}.\\end{split} |  | (7.7) |

We now connect this bound to the convergence of the average strategy profile. Let π∗,μ∗\\pi^{\*},\\mu^{\*} be the solution to [7.1](https://arxiv.org/html/2604.28186v1#S7.E1 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), and define the average strategies π¯≔1T​∑t=1Tπ(t)\\mkern 1.5mu\\overline{\\mkern-1.5mu\\pi\\mkern-1.5mu}\\mkern 1.5mu\\coloneqq\\frac{1}{T}\\sum\_{t=1}^{T}\\pi^{(t)} and μ¯≔1T​∑t=1Tμ(t)\\mkern 1.5mu\\overline{\\mkern-1.5mu\\mu\\mkern-1.5mu}\\mkern 1.5mu\\coloneqq\\frac{1}{T}\\sum\_{t=1}^{T}\\mu^{(t)}. The left-hand side of [7.7](https://arxiv.org/html/2604.28186v1#S7.E7 "In 7.3 Computation of Equilibrium ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") corresponds to the duality gap: maxμ^∈Δ×S∈𝒮𝒜SF(π¯,μ^)−minπ^∈Δ𝒜F(π^,μ¯)\\max\_{\\widehat{\\mu}\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}}F(\\mkern 1.5mu\\overline{\\mkern-1.5mu\\pi\\mkern-1.5mu}\\mkern 1.5mu,\\widehat{\\mu})-\\min\_{\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}}F(\\widehat{\\pi},\\mkern 1.5mu\\overline{\\mkern-1.5mu\\mu\\mkern-1.5mu}\\mkern 1.5mu). Since π∗,μ∗\\pi^{\*},\\mu^{\*} are optimal solutions to [7.7](https://arxiv.org/html/2604.28186v1#S7.E7 "In 7.3 Computation of Equilibrium ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), they satisfy

|     |     |     |
| --- | --- | --- |
|  | minπ^∈Δ𝒜F(π^,μ¯)≤F(π∗,μ∗)≤maxμ^∈Δ×S∈𝒮𝒜SF(π¯,μ^).\\displaystyle\\min\_{\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}}F(\\widehat{\\pi},\\mkern 1.5mu\\overline{\\mkern-1.5mu\\mu\\mkern-1.5mu}\\mkern 1.5mu)\\leq F(\\pi^{\*},\\mu^{\*})\\leq\\max\_{\\widehat{\\mu}\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}}F(\\mkern 1.5mu\\overline{\\mkern-1.5mu\\pi\\mkern-1.5mu}\\mkern 1.5mu,\\widehat{\\mu}). |  |

Combining these pieces, we arrive at the following finite-time convergence guarantee:

###### Theorem 7.4.

Let π∗,μ∗\\pi^{\*},\\mu^{\*} be the solution of [7.1](https://arxiv.org/html/2604.28186v1#S7.E1 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), and define π¯≔1T​∑t=1Tπ(t),μ¯≔1T​∑t=1Tμ(t)\\mkern 1.5mu\\overline{\\mkern-1.5mu\\pi\\mkern-1.5mu}\\mkern 1.5mu\\coloneqq\\frac{1}{T}\\sum\_{t=1}^{T}\\pi^{(t)},~\\mkern 1.5mu\\overline{\\mkern-1.5mu\\mu\\mkern-1.5mu}\\mkern 1.5mu\\coloneqq\\frac{1}{T}\\sum\_{t=1}^{T}\\mu^{(t)}. Then, for any δ>0\\delta>0, with probability at least 1−δ1-\\delta, we have

|     |     |     |
| --- | --- | --- |
|  | maxμ^∈Δ×S∈𝒮𝒜SF(π¯,μ^)≤F(π∗,μ∗)+4\|𝒯\|1+(tw⁡(𝒢)+1)​log⁡Aη​T+4η\|𝒯\|+22​log⁡2δT.\\displaystyle\\max\_{\\widehat{\\mu}\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}}F(\\mkern 1.5mu\\overline{\\mkern-1.5mu\\pi\\mkern-1.5mu}\\mkern 1.5mu,\\widehat{\\mu})\\leq F(\\pi^{\*},\\mu^{\*})+4\\left\|{\\mathcal{T}}\\right\|\\frac{1+\\left({\\rm tw}(\\mathcal{G})+1\\right)\\log A}{\\eta T}+4\\eta\\left\|{\\mathcal{T}}\\right\|+2\\sqrt{\\frac{2\\log\\frac{2}{\\delta}}{T}}. |  |

With η=1T\\eta=\\frac{1}{\\sqrt{T}}, the average strategy π¯\\mkern 1.5mu\\overline{\\mkern-1.5mu\\pi\\mkern-1.5mu}\\mkern 1.5mu constitutes an 𝒪⁡(\|𝒯\|⋅tw⁡(𝒢)​log⁡A+log⁡2δT)\\mathcal{O}\\left(\\frac{\|{\\mathcal{T}}\|\\cdot{\\rm tw}(\\mathcal{G})\\log A+\\sqrt{\\log\\frac{2}{\\delta}}}{\\sqrt{T}}\\right)-MASE. The overall running time is 𝒪⁡(T⋅\|𝒮\|⋅\|𝒯\|⋅Atw⁡(𝒢)+1)\\mathcal{O}\\left(T\\cdot\|{\\mathcal{S}}\|\\cdot\|{\\mathcal{T}}\|\\cdot A^{{\\rm tw}(\\mathcal{G})+1}\\right). Hence, the exponential dependence aligns with the lower bound in [Theorem6.3](https://arxiv.org/html/2604.28186v1#S6.theoremcounter3 "Theorem 6.3 (Treewidth). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").

###### Remark 7.5(Extension to Weighted Sum and Maximum over Coalition Gains).

The correlator-deviator framework in this section extends directly to other coalition objectives, including a weighted sum (or weighted average) of deviation gains and the maximum deviation gain within a coalition. In particular, we can optimize

|     |     |     |     |     |
| --- | --- | --- | --- | --- |
|  |  | minπ∈Δ𝒜⁡maxS∈𝒮​max⁡∑i∈S𝒂^S∈𝒜S⁡wS,i​𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\min\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\sum\_{i\\in S}w\_{S,i}\\,\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  | (Weighted Sum) |
|  |  | minπ∈Δ𝒜⁡maxS∈𝒮​max𝒂^S∈𝒜S​maxi∈S​𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\],\\displaystyle\\min\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\max\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]\\,, |  | (Maximum) |

where 𝒘:={wS,i}S∈𝒮,i∈S\\bm{w}:=\\left\\{w\_{S,i}\\right\\}\_{S\\in{\\mathcal{S}},\\,i\\in S} is an arbitrary collection of weights ( _e.g._, ∑i∈SwS,i=1\\sum\_{i\\in S}w\_{S,i}=1 if one prefers a weighted _average_ for each coalition SS).
For [Weighted Sum](https://arxiv.org/html/2604.28186v1#S7.Ex7 "In Remark 7.5 (Extension to Weighted Sum and Maximum over Coalition Gains). ‣ 7.3 Computation of Equilibrium ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), the algorithm and analysis are unchanged. We focus on the uniform average solely for ease of exposition.
For [Maximum](https://arxiv.org/html/2604.28186v1#S7.Ex8 "In Remark 7.5 (Extension to Weighted Sum and Maximum over Coalition Gains). ‣ 7.3 Computation of Equilibrium ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), it suffices to augment the deviator’s decision to also select the player whose gain is evaluated, _i.e._, replace μ⁡(S,𝒂^S)\\mu(S,\\widehat{\\bm{a}}\_{S}) by μ⁡(S,i,𝒂^S)\\mu(S,i,\\widehat{\\bm{a}}\_{S}) over triples (S,i,𝒂^S)(S,i,\\widehat{\\bm{a}}\_{S}) with i∈Si\\in S. The resulting meta-game is then equivalent to [Maximum](https://arxiv.org/html/2604.28186v1#S7.Ex8 "In Remark 7.5 (Extension to Weighted Sum and Maximum over Coalition Gains). ‣ 7.3 Computation of Equilibrium ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation").

## 8 Experiments

In this section, we compare our algorithm against several baselines: Follow the Regularized Leader with a Euclidean regularizer (FTRL), Hedge, Follow the Perturbed Leader with an exponential noise distribution (FTPL; all players run FTPL independently), and Online Mirror Descent with a Euclidean regularizer (OMD) ( [Hazan et al., 2016](https://arxiv.org/html/2604.28186v1#bib.bib23 "")). We also plot the ground-truth MASE computed via linear programming (LP) in [AppendixA](https://arxiv.org/html/2604.28186v1#A1 "Appendix A Linear Programming for Solving ‣ Computing Equilibrium beyond Unilateral Deviation"). Finally, to highlight the distinction between MASE and CCE, we also plot the CCE that minimizes the coalition exploitability defined below (Optimal CCE).

We evaluate the algorithms on three criteria:

- •


Exploitability. (maxi∈\[N\]⁡maxa^i∈𝒜i​𝔼𝒂∼π​\[𝒰i​(a^i,𝒂−i)−𝒰i​(𝒂)\]\\max\_{i\\in\[N\]}\\max\_{\\widehat{a}\_{i}\\in\\mathcal{A}\_{i}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\!\\left\[\\mathcal{U}\_{i}(\\widehat{a}\_{i},\\bm{a}\_{-i})-\\mathcal{U}\_{i}(\\bm{a})\\right\]): the maximum gain a single player can obtain by deviating unilaterally. Exploitability ≤0\\leq 0 indicate a Nash equilibrium (or a correlated equilibrium if π\\pi is correlated).

- •


Coalition exploitability. (maxμ∈Δ×S∈𝒮𝒜SF(π,μ)\\max\_{\\mu\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}}F(\\pi,\\mu)): the maximum average gain when a coalition deviates simultaneously. We take 𝒮{\\mathcal{S}} to be the set of all non-empty player subsets.

- •


Social welfare. (∑i=1N𝔼𝒂∼π​\[𝒰i​(𝒂)\]\\sum\_{i=1}^{N}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}(\\bm{a})\\right\]): the sum of all players’ utilities.


Utility definitions and additional details are provided in [AppendixH](https://arxiv.org/html/2604.28186v1#A8 "Appendix H Additional Experimental Results ‣ Computing Equilibrium beyond Unilateral Deviation"). In Prisoner’s Dilemma ( [Luce and Raiffa, 1957](https://arxiv.org/html/2604.28186v1#bib.bib32 "")), the MASE corresponds to players choosing (C,D)(C,D) and (D,C)(D,C) with probability 0.50.5 each, yielding a social welfare of 1.01.0. In contrast, because the unique NE/CCE in this game is (D,D)(D,D), the baselines converge to that outcome, with a lower social welfare of 0.40.4. Thus, in Prisoner’s Dilemma, MASE promotes cooperation and achieves higher utility.

In the Stag Hunt, there are two Nash equilibria, one of which attains higher utility. As shown in [Figure3](https://arxiv.org/html/2604.28186v1#S8.F3 "In 8 Experiments ‣ Computing Equilibrium beyond Unilateral Deviation"), all baselines converge to the worse equilibrium, whereas MASE converges to the better one.
Finally, in terms of exploitability (unilateral deviations), MASE remains close to the baselines, while the baselines are substantially more fragile to multilateral deviations.

Figure 3: LP denotes the linear programming solution from [AppendixA](https://arxiv.org/html/2604.28186v1#A1 "Appendix A Linear Programming for Solving ‣ Computing Equilibrium beyond Unilateral Deviation"), and Maximum denotes the maximum achievable social welfare. The baselines are comparatively fragile to multilateral deviations, while MASE is more robust and achieves higher social welfare. At the same time, MASE’s exploitability is close to that of the baselines.

### 8.1 Gap between Optimal CCE and Baseline Algorithms

In [Figure4](https://arxiv.org/html/2604.28186v1#S8.F4 "In 8.1 Gap between Optimal CCE and Baseline Algorithms ‣ 8 Experiments ‣ Computing Equilibrium beyond Unilateral Deviation"), we compare the coalition exploitability achieved by the baseline algorithms, MASE, and the optimal CCE, _i.e._, the CCE with the smallest coalition exploitability. The figure shows that the optimal CCE remains close to MASE in terms of coalition exploitability, whereas none of the baseline algorithms approaches it. Instead, the baseline methods exhibit substantially larger coalition exploitability than MASE, highlighting the importance of explicitly accounting for multilateral deviations.

Figure 4: Coalition exploitability in random normal-form games with varying numbers of players and action-set sizes, where 𝒮{\\mathcal{S}} contains all possible coalitions (\|𝒮\|=2N−1\|{\\mathcal{S}}\|=2^{N}-1). In each game, all players have the same action-set size AA, and each entry of the utility matrix is sampled independently and uniformly from \[0,1\]\[0,1\], and then normalized so that the minimum and maximum entries are exactly 00 and 11, respectively.

### 8.2 Coalition Exploitability in Larger Games

As shown in [Figure5](https://arxiv.org/html/2604.28186v1#S8.F5 "In 8.2 Coalition Exploitability in Larger Games ‣ 8 Experiments ‣ Computing Equilibrium beyond Unilateral Deviation"), the coalition exploitability of the average strategy generated by classical no-regret learning algorithms increases as the game size grows. Note that we only consider coalitions of size no more than two. This trend underscores the importance of minimizing coalition exploitability. As games become larger, the equilibria to which these algorithms converge become increasingly fragile to coalition deviations, necessitating approaches that explicitly account for such multilateral deviations. Further details are provided in [AppendixI](https://arxiv.org/html/2604.28186v1#A9 "Appendix I Polymatrix Games ‣ Computing Equilibrium beyond Unilateral Deviation").

Figure 5: The coalition exploitability of random polymatrix games of different sizes when coalitions with no more than two players are considered. A larger expected number of interactions per player (cc) generally corresponds to a larger treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").

## 9 Application: Tradeoff between Exploitability and Social Welfare

In [Figure3](https://arxiv.org/html/2604.28186v1#S8.F3 "In 8 Experiments ‣ Computing Equilibrium beyond Unilateral Deviation"), we see that allowing exploitability to increase from 0.00.0 to 0.10.1 raises the social welfare of MASE from 0.40.4 to 1.01.0. This begs a classical equilibrium-selection question, finding an equilibrium that maximizes social welfare ( [Conitzer and Sandholm, 2008](https://arxiv.org/html/2604.28186v1#bib.bib14 ""); [Papadimitriou and Roughgarden, 2008](https://arxiv.org/html/2604.28186v1#bib.bib37 "")), and its natural extension:

> Given a tolerance ϵ≥0\\epsilon\\geq 0, what is the optimal ϵ\\epsilon-approximate equilibrium that maximizes social welfare?

In other words, if we allow an equilibrium to be exploitable, _i.e._, we permit unilateral deviations to improve a player’s expected utility by up to ϵ\\epsilon, how much additional social welfare can we obtain? We formalize this welfare-robustness trade-off via the _Exploitability Welfare Frontier_ (EWF) in the next section.

### 9.1 Exploitability Welfare Frontier (EWF)

We plot, in [Figure6](https://arxiv.org/html/2604.28186v1#S9.F6 "In 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation"), the maximum achievable social welfare as a function of the exploitability ϵ\\epsilon. We refer to this curve as the _Exploitability Welfare Frontier (EWF)_, defined below.

###### Definition 9.1(Exploitability Welfare Frontier (EWF)).

1. The exploitability welfare frontier for CCE, denoted EWFCCE​(ϵ):\[0,1\]→\[0,N\]{\\rm EWF}^{\\rm CCE}(\\epsilon)\\colon\[0,1\]\\to\[0,N\], is the maximum social welfare attainable among all ϵ\\epsilon-approximate CCEs. Formally,



|     |     |     |     |
| --- | --- | --- | --- |
|  | EWFCCE​(ϵ)≔max⁡∑i=1Nπ∈ϵ​-CCE⁡𝔼𝒂∼π​\[𝒰i​(𝒂)\].\\displaystyle{\\rm EWF}^{\\rm CCE}(\\epsilon)\\coloneqq\\max\_{\\pi\\in\\epsilon\\text{-CCE}}\\sum\_{i=1}^{N}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}(\\bm{a})\\right\]. |  | (9.1) |



where



|     |     |     |     |
| --- | --- | --- | --- |
|  | ϵ​-CCE≔{π∈Δ𝒜:maxi∈\[N\]⁡maxa^i∈𝒜i​𝔼𝒂∼π​\[𝒰i​(a^i,𝒂−i)−𝒰i​(𝒂)\]≤ϵ}.\\displaystyle\\epsilon\\text{-CCE}\\coloneqq\\left\\{\\pi\\in\\Delta^{\\mathcal{A}}\\colon\\max\_{i\\in\[N\]}\\max\_{\\widehat{a}\_{i}\\in\\mathcal{A}\_{i}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\!\\left\[\\mathcal{U}\_{i}(\\widehat{a}\_{i},\\bm{a}\_{-i})-\\mathcal{U}\_{i}(\\bm{a})\\right\]\\leq\\epsilon\\right\\}. |  | (9.2) |


Analogously, one can define EWFNE{\\rm EWF}^{\\rm NE} and EWFCE{\\rm EWF}^{\\rm CE} for Nash and correlated equilibria, respectively.

Figure 6: EWFCCE{\\rm EWF}^{\\rm CCE} over four different games.

Prior work has investigated related welfare–approximation trade-offs for NE ( _e.g._, in congestion games ( [Christodoulou et al., 2011](https://arxiv.org/html/2604.28186v1#bib.bib13 "")) and two-player normal-form games ( [Czumaj et al., 2015](https://arxiv.org/html/2604.28186v1#bib.bib15 ""))). However, computational barriers limit what is achievable. [Czumaj et al. (2015)](https://arxiv.org/html/2604.28186v1#bib.bib15 "")’s algorithm relies on an efficient oracle for computing approximate NE, yet computing NE is PPAD-hard ( [Chen and Deng, 2006](https://arxiv.org/html/2604.28186v1#bib.bib12 ""); [Daskalakis et al., 2009](https://arxiv.org/html/2604.28186v1#bib.bib16 "")). Moreover, [Deligkas et al. (2016)](https://arxiv.org/html/2604.28186v1#bib.bib17 "") shows that finding the welfare-maximizing approximate NE can require superpolynomial time even in two-player normal-form games.
Hence, to ensure computational tractability, we leave these extensions out of scope and focus on EWFCCE{\\rm EWF}^{\\rm CCE} throughout.

We establish basic structural properties of [EWF\\
CCE](https://arxiv.org/html/2604.28186v1#S9.I1.i1 "In Definition 9.1 (Exploitability Welfare Frontier (EWF)). ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") in the following lemmas.

###### Lemma 9.2.

In any game, [EWF\\
CCE](https://arxiv.org/html/2604.28186v1#S9.I1.i1 "In Definition 9.1 (Exploitability Welfare Frontier (EWF)). ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") is non-decreasing, concave, and piecewise linear as a function of ϵ\\epsilon.

###### Lemma 9.3.

The slope of the [EWF\\
CCE](https://arxiv.org/html/2604.28186v1#S9.I1.i1 "In Definition 9.1 (Exploitability Welfare Frontier (EWF)). ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") can be as small as zero and is unbounded above.

The proof is deferred to [AppendixJ](https://arxiv.org/html/2604.28186v1#A10 "Appendix J Omitted Proofs for ‣ Computing Equilibrium beyond Unilateral Deviation"). By [Lemma9.2](https://arxiv.org/html/2604.28186v1#S9.theoremcounter2 "Lemma 9.2. ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation"), the [EWF\\
CCE](https://arxiv.org/html/2604.28186v1#S9.I1.i1 "In Definition 9.1 (Exploitability Welfare Frontier (EWF)). ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") is concave. Hence, its slope is non-increasing in ϵ\\epsilon wherever it is differentiable. The same concavity argument also yields the following lower bound on the price of stability ( [Nisan et al., 2007](https://arxiv.org/html/2604.28186v1#bib.bib36 "")) of ϵ\\epsilon-CCE.

###### Corollary 9.4.

For any finite game with positive optimal social welfare and any ϵ∈\[0,1\]\\epsilon\\in\\left\[0,1\\right\], the price of stability of ϵ\\epsilon-CCE satisfies

|     |     |     |
| --- | --- | --- |
|  | max⁡∑i=1Nπ∈ϵ​-CCE⁡𝔼𝒂∼π​\[𝒰i​(𝒂)\]max⁡∑i=1Nπ∈Δ𝒜⁡𝔼𝒂∼π​\[𝒰i​(𝒂)\]≥ϵ.\\displaystyle\\frac{\\max\_{\\pi\\in\\epsilon\\text{-CCE}}\\sum\_{i=1}^{N}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}(\\bm{a})\\right\]}{\\max\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\sum\_{i=1}^{N}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}(\\bm{a})\\right\]}\\geq\\epsilon. |  |

[Corollary9.4](https://arxiv.org/html/2604.28186v1#S9.theoremcounter4 "Corollary 9.4. ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") follows directly from the concavity of the EWF function.

### 9.2 Finding a Pareto Optimal Strategy

A natural next question is: given a tolerance ϵ≥0\\epsilon\\geq 0 on exploitability, how do we compute a strategy that maximizes social welfare among all ϵ\\epsilon-approximate CCEs? We show that this can be computed efficiently using a variant of our MASE framework. Specifically, we solve the following weighted objective:

|     |     |     |     |
| --- | --- | --- | --- |
|  | argminπ∈Δ𝒜maxS∈𝒮⁡max𝒂^S∈𝒜S​wS\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\],\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{w\_{S}}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\], |  | (9.3) |

where 𝒘∈ℝ𝒮\\bm{w}\\in\\mathbb{R}^{{\\mathcal{S}}} is a vector of non-negative weights. We have the following lemma.

###### Lemma 9.5.

For any ϵ>0\\epsilon>0, computing the CCE with exploitability no more than ϵ\\epsilon that maximizes social welfare is equivalent to [9.3](https://arxiv.org/html/2604.28186v1#S9.E3 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") by setting 𝒮={{i}}i∈\[N\]∪{\[N\]}{\\mathcal{S}}=\\left\\{\\left\\{i\\right\\}\\right\\}\_{i\\in\[N\]}\\cup\\left\\{\[N\]\\right\\} and using the weights:

|     |     |     |
| --- | --- | --- |
|  | wS={wif ​\|S\|=11−wif ​S=\[N\]\\displaystyle w\_{S}=\\begin{cases}w&\\text{if }\|S\|=1\\\<br>1-w&\\text{if }S=\[N\]\\end{cases} |  |

for some w∈\[0,1)w\\in\[0,1). Conversely, solving [9.3](https://arxiv.org/html/2604.28186v1#S9.E3 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") with these parameters corresponds to finding a point on the Pareto frontier of social welfare and exploitability.\
\
The proof is postponed to [AppendixJ](https://arxiv.org/html/2604.28186v1#A10 "Appendix J Omitted Proofs for ‣ Computing Equilibrium beyond Unilateral Deviation"). In [Figure7](https://arxiv.org/html/2604.28186v1#S9.F7 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation"), we plot the exploitability and social welfare of the strategy induced by varying ww. For the Stag Hunt, because one of the Nash equilibria already attains maximal social welfare, the social welfare remains fixed at its optimal value for all w∈\[0,1)w\\in\[0,1).\
\
Figure 7: The trade-off between exploitability and social welfare in Prisoner’s Dilemma and the Stag Hunt.\
\
With [Lemma9.5](https://arxiv.org/html/2604.28186v1#S9.theoremcounter5 "Lemma 9.5. ‣ 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation"), we can compute EWFCCE{\\rm EWF}^{\\rm CCE} by solving [9.3](https://arxiv.org/html/2604.28186v1#S9.E3 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") for different values of ww. This also yields an efficient algorithm (fixed-parameter tractable in the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), as in [Section7](https://arxiv.org/html/2604.28186v1#S7 "7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation")) for computing the socially optimal approximate CCE.\
\
Fix a target tolerance ϵ>0\\epsilon>0, We can recover an optimal ϵ\\epsilon-approximate CCE as follows.\
By [Lemma9.5](https://arxiv.org/html/2604.28186v1#S9.theoremcounter5 "Lemma 9.5. ‣ 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation"), each choice of w∈\[0,1)w\\in\[0,1) induces a point on the [EWF\\
CCE](https://arxiv.org/html/2604.28186v1#S9.I1.i1 "In Definition 9.1 (Exploitability Welfare Frontier (EWF)). ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation"), with the resulting solution attaining some exploitability level ϵ′\\epsilon^{\\prime}. Moreover, ϵ′\\epsilon^{\\prime} decreases monotonically as ww increases. This monotone correspondence suggests a simple approach: perform a binary search over ww to find the optimal strategy whose exploitability does not exceed the target ϵ\\epsilon. The details are given in [Algorithm1](https://arxiv.org/html/2604.28186v1#algorithm1 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
Algorithm 1Binary Search\
\
Input:The exploitability tolerance ϵ\\epsilon and the floating-point tolerance EPS{\\rm EPS}.\
\
Output:EWFCCE​(ϵ){\\rm EWF}^{\\rm CCE}(\\epsilon).\
\
1l←0,r←1l\\leftarrow 0,r\\leftarrow 1.\
\
2while _r−l>EPSr-l>{\\rm EPS}_ do\
\
3w←l+r2w\\leftarrow\\frac{l+r}{2}\
\
4\
Solve [9.3](https://arxiv.org/html/2604.28186v1#S9.E3 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") associated with ww.\
\
5\
Compute the exploitability ϵ′\\epsilon^{\\prime} and the social welfare s​wsw of the resulting strategy.\
\
6if _ϵ′≤ϵ\\epsilon^{\\prime}\\leq\\epsilon_ then\
\
7s​wfinal←s​wsw^{\\rm final}\\leftarrow sw\
\
8r←wr\\leftarrow w\
\
9else\
\
10l←wl\\leftarrow w\
\
11\
end if\
\
12\
end while\
\
Return:s​wfinalsw^{\\rm final}.\
\
Despite the tractability of our approach when [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") has a bounded treewidth, computing the [EWF\\
CCE](https://arxiv.org/html/2604.28186v1#S9.I1.i1 "In Definition 9.1 (Exploitability Welfare Frontier (EWF)). ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") is intractable in general succinct games: even evaluating the value at ϵ=0\\epsilon=0 ( _i.e._, maximum welfare over exact CCEs) is NP-hard in a number of standard succinct game classes.\
\
###### Lemma 9.6.\
\
Computing EWFCCE​(0){\\rm EWF}^{\\rm CCE}(0) is NP-hard in each of the following succinct games:\
\
1. 1.\
\
\
Bounded-degree, bipartite graphical games.\
\
2. 2.\
\
\
Polymatrix games.\
\
3. 3.\
\
\
Hypergraphical games.\
\
4. 4.\
\
\
Congestion games.\
\
5. 5.\
\
\
Local effect games.\
\
6. 6.\
\
\
Facility location games.\
\
7. 7.\
\
\
Network design games.\
\
8. 8.\
\
\
Scheduling games.\
\
\
The proof is postponed to [AppendixJ](https://arxiv.org/html/2604.28186v1#A10 "Appendix J Omitted Proofs for ‣ Computing Equilibrium beyond Unilateral Deviation"). Still, it may be possible to evaluate EWFCCE​(ϵ){\\rm EWF}^{\\rm CCE}(\\epsilon) efficiently when ϵ\\epsilon is sufficiently large. For example, [Tsaknakis and Spirakis (2007)](https://arxiv.org/html/2604.28186v1#bib.bib43 "") gave a polynomial-time algorithm for computing an ϵ\\epsilon-approximate Nash equilibrium (with exploitability at most ϵ\\epsilon) for ϵ≥0.3393\\epsilon\\geq 0.3393, whereas computing approximate Nash equilibria in general is PPAD-hard ( [Chen and Deng, 2006](https://arxiv.org/html/2604.28186v1#bib.bib12 ""); [Daskalakis et al., 2009](https://arxiv.org/html/2604.28186v1#bib.bib16 "")). This suggests that, for large enough ϵ\\epsilon, computing EWFCCE​(ϵ){\\rm EWF}^{\\rm CCE}(\\epsilon) may be computationally tractable.\
\
## 10 Conclusion\
\
In this work, we introduced the Minimum Average-Strong Equilibrium (MASE), a tractable solution concept that accounts for multilateral deviations by minimizing each coalition’s average incentive to deviate. We established that computing an approximate MASE is NP-hard even with singleton coalitions and proved a lower bound showing unavoidable exponential dependence on the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). Complementing these hardness results, we design an algorithm that combines a correlator-deviator meta-game with FTPL updates and dynamic programming over a tree decomposition. Its exponential dependence on the treewidth matches the lower bound. We also showed how this framework can be used to compute the exploitability welfare frontier (EWF). Empirically, MASE is substantially more robust to coalition deviations than standard baselines, while improving social welfare in canonical games and often incurring little to no increase in unilateral exploitability. Finally, we showed that minimizing the minimum deviation gain within each coalition, _i.e._, computing a minimum strong CCE, is also NP-hard, even when the joint action space is polynomial in the number of players. This further motivates our focus on minimizing average coalitional gain.\
\
## References\
\
- Agarwal et al. (2019)\
Naman Agarwal, Alon Gonen, and Elad Hazan.\
\
Learning in non-convex games with an optimization oracle.\
\
In _Conference on Learning Theory (COLT)_, 2019.\
\
- Anagnostides et al. (2022)\
Ioannis Anagnostides, Gabriele Farina, Ioannis Panageas, and Tuomas Sandholm.\
\
Optimistic mirror descent either converges to Nash or to strong coarse correlated equilibria in bimatrix games.\
\
In _Neural Information Processing Systems (NeurIPS)_, 2022.\
\
- Anagnostides et al. (2025)\
Ioannis Anagnostides, Gabriele Farina, Tuomas Sandholm, and Brian Hu Zhang.\
\
A polynomial-time algorithm for variational inequalities under the Minty condition.\
\
_arXiv preprint arXiv:2504.03432_, 2025.\
\
- Arora and Barak (2009)\
Sanjeev Arora and Boaz Barak.\
\
_Computational complexity: a modern approach_.\
\
Cambridge University Press, 2009.\
\
- Aumann (1959)\
Robert Aumann.\
\
_Acceptable points in General Cooperative nn-person Games_, pages 287–324.\
\
Princeton University Press, 01 1959.\
\
doi: 10.1090/fic/023/01.\
\
- Aumann (1974)\
Robert J Aumann.\
\
Subjectivity and correlation in randomized strategies.\
\
_Journal of mathematical Economics_, 1(1):67–96, 1974.\
\
- Bergstrom and Godfrey-Smith (1998)\
Carl T Bergstrom and Peter Godfrey-Smith.\
\
On the evolution of behavioral heterogeneity in individuals and populations.\
\
_Biology and Philosophy_, 13(2):205–231, 1998.\
\
- Bernheim et al. (1987)\
B Douglas Bernheim, Bezalel Peleg, and Michael D Whinston.\
\
Coalition-proof Nash equilibria I. concepts.\
\
_Journal of economic theory_, 42(1):1–12, 1987.\
\
- Berthelsen and Hansen (2022)\
Marie Louisa Tølbøll Berthelsen and Kristoffer Arnsfelt Hansen.\
\
On the computational complexity of decision problems about multi-player Nash equilibria.\
\
_Theory of Computing Systems_, 66(3):519–545, 2022.\
\
- Borgs et al. (2010)\
Christian Borgs, Jennifer Chayes, Nicole Immorlica, Adam Tauman Kalai, Vahab Mirrokni, and Christos Papadimitriou.\
\
The myth of the folk theorem.\
\
_Games and Economic Behavior_, 70(1):34–43, 2010.\
\
- Cesa-Bianchi and Lugosi (2006)\
Nicolo Cesa-Bianchi and Gábor Lugosi.\
\
_Prediction, learning, and games_.\
\
Cambridge university press, 2006.\
\
- Chen and Deng (2006)\
Xi Chen and Xiaotie Deng.\
\
Settling the complexity of two-player Nash equilibrium.\
\
In _Symposium on Foundations of Computer Science (FOCS)_, 2006.\
\
- Christodoulou et al. (2011)\
George Christodoulou, Elias Koutsoupias, and Paul G Spirakis.\
\
On the performance of approximate equilibria in congestion games.\
\
_Algorithmica_, 61(1):116–140, 2011.\
\
- Conitzer and Sandholm (2008)\
Vincent Conitzer and Tuomas Sandholm.\
\
New complexity results about Nash equilibria.\
\
_Games and Economic Behavior_, 63(2):621–641, 2008.\
\
- Czumaj et al. (2015)\
Artur Czumaj, Michail Fasoulakis, and Marcin Jurdzinski.\
\
Approximate Nash equilibria with near optimal social welfare.\
\
In _International Joint Conference on Artificial Intelligence (IJCAI)_, 2015.\
\
- Daskalakis et al. (2009)\
Constantinos Daskalakis, Paul W Goldberg, and Christos H Papadimitriou.\
\
The complexity of computing a Nash equilibrium.\
\
_Communications of the ACM_, 52(2):89–97, 2009.\
\
- Deligkas et al. (2016)\
Argyrios Deligkas, John Fearnley, and Rahul Savani.\
\
Inapproximability results for approximate Nash equilibria.\
\
In _International Conference on Web and Internet Economics (WINE)_, 2016.\
\
- Diestel (2025)\
Reinhard Diestel.\
\
_Graph theory_, volume 173.\
\
Springer Nature, 2025.\
\
- Eaves (1973)\
B Curtis Eaves.\
\
Polymatrix games with joint constraints.\
\
_SIAM Journal on Applied Mathematics_, 24(3):418–423, 1973.\
\
- Esmer et al. (2024)\
Barış Can Esmer, Jacob Focke, Dániel Marx, and Paweł Rzążewski.\
\
Fundamental problems on bounded-treewidth graphs: The real source of hardness.\
\
In _International Colloquium on Automata, Languages and Programming (ICALP)_, 2024.\
\
- Gatti et al. (2013)\
Nicola Gatti, Marco Rocco, and Tuomas Sandholm.\
\
On the verification and computation of strong Nash equilibrium.\
\
In _International Conference on Autonomous Agents and MultiAgent Systems (AAMAS)_, 2013.\
\
- Hart and Schmeidler (1989)\
Sergiu Hart and David Schmeidler.\
\
Existence of correlated equilibria.\
\
_Mathematics of Operations Research_, 14(1):18–25, 1989.\
\
- Hazan et al. (2016)\
Elad Hazan et al.\
\
Introduction to online convex optimization.\
\
_Foundations and Trends® in Optimization_, 2(3-4):157–325, 2016.\
\
- Hoefer (2013)\
Martin Hoefer.\
\
Strategic cooperation in cost sharing games.\
\
_International Journal of Game Theory_, 42(1):29–53, 2013.\
\
- Holzman and Law-Yone (1997)\
Ron Holzman and Nissan Law-Yone.\
\
Strong equilibrium in congestion games.\
\
_Games and economic behavior_, 21(1-2):85–101, 1997.\
\
- Howson Jr (1972)\
Joseph T Howson Jr.\
\
Equilibria of polymatrix games.\
\
_Management Science_, 18(5-part-1):312–318, 1972.\
\
- Impagliazzo and Paturi (2001)\
Russell Impagliazzo and Ramamohan Paturi.\
\
On the complexity of k-SAT.\
\
_Journal of Computer and System Sciences_, 62(2):367–375, 2001.\
\
- Kakade et al. (2003)\
Sham Kakade, Michael Kearns, John Langford, and Luis Ortiz.\
\
Correlated equilibria in graphical games.\
\
In _ACM Conference on Electronic Commerce_, 2003.\
\
- Kawase and Sumita (2020)\
Yasushi Kawase and Hanna Sumita.\
\
On the max-min fair stochastic allocation of indivisible goods.\
\
In _AAAI Conference on Artificial Intelligence (AAAI)_, 2020.\
\
- Kearns et al. (2001)\
Michael J. Kearns, Michael L. Littman, and Satinder Singh.\
\
Graphical models for game theory.\
\
In _Conference on Uncertainty in Artificial Intelligence (UAI)_, 2001.\
\
- Lokshtanov et al. (2011)\
Daniel Lokshtanov, Dániel Marx, and Saket Saurabh.\
\
Known algorithms on graphs of bounded treewidth are probably optimal.\
\
In _ACM-SIAM Symposium on Discrete Algorithms (SODA)_, 2011.\
\
- Luce and Raiffa (1957)\
Duncan R.. Luce and Howard Raiffa.\
\
_Games and Decisions_.\
\
wiley, 1957.\
\
- Moulin and Vial (1978)\
Hervé Moulin and J-P Vial.\
\
Strategically zero-sum games: the class of games whose completely mixed equilibria cannot be improved upon.\
\
_International Journal of Game Theory_, 7(3-4):201–221, 1978.\
\
- Nash (1950)\
John F Nash.\
\
Equilibrium points in nn-person games.\
\
_Proceedings of the national academy of sciences_, 36(1):48–49, 1950.\
\
- Nessah and Tian (2014)\
Rabia Nessah and Guoqiang Tian.\
\
On the existence of strong Nash equilibria.\
\
_Journal of Mathematical Analysis and Applications_, 414(2):871–885, 2014.\
\
- Nisan et al. (2007)\
Noam Nisan, Tim Roughgarden, Eva Tardos, and Vijay V Vazirani.\
\
_Algorithmic game theory_.\
\
Cambridge university press, 2007.\
\
- Papadimitriou and Roughgarden (2008)\
Christos H Papadimitriou and Tim Roughgarden.\
\
Computing correlated equilibria in multi-player games.\
\
_Journal of the ACM (JACM)_, 55(3):1–29, 2008.\
\
- Pigou (2017)\
Arthur Pigou.\
\
_The economics of welfare_.\
\
Routledge, 2017.\
\
- Rahn and Schäfer (2015)\
Mona Rahn and Guido Schäfer.\
\
Efficient equilibria in polymatrix coordination games.\
\
In _International Symposium on Mathematical Foundations of Computer Science (MFCS)_, 2015.\
\
- Rosenthal (1973)\
Robert W Rosenthal.\
\
A class of games possessing pure-strategy Nash equilibria.\
\
_International Journal of Game Theory_, 2(1):65–67, 1973.\
\
- Rozenfeld and Tennenholtz (2006)\
Ola Rozenfeld and Moshe Tennenholtz.\
\
Strong and correlated strong equilibria in monotone congestion games.\
\
In _International Workshop on Internet and Network Economics_, pages 74–86. Springer, 2006.\
\
- Suggala and Netrapalli (2020)\
Arun Sai Suggala and Praneeth Netrapalli.\
\
Online non-convex learning: Following the perturbed leader is optimal.\
\
In _Algorithmic Learning Theory (ALT)_, 2020.\
\
- Tsaknakis and Spirakis (2007)\
Haralampos Tsaknakis and Paul G Spirakis.\
\
An optimization approach for approximate Nash equilibria.\
\
In _International workshop on web and internet economics_. Springer, 2007.\
\
- van Megen et al. (1996)\
F.J.C. van Megen, G. Facchini, P.E.M. Borm, and S.H. Tijs.\
\
Strong Nash equilibria and the potential maimizer.\
\
Center discussion paper, Operations Research, 1996.\
\
- Von Stackelberg (2010)\
Heinrich Von Stackelberg.\
\
_Market structure and equilibrium_.\
\
Springer Science & Business Media, 2010.\
\
\
## Appendix A Linear Programming for Solving [MASE](https://arxiv.org/html/2604.28186v1\#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
[MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation") can be solved by the following linear programming\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | minπ,w⁡w\\displaystyle\\min\_{\\pi,w}w |  |\
|  |  | w≥1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]​∀S∈𝒮,𝒂^S∈𝒜S\\displaystyle w\\geq\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]~~~\\forall S\\in{\\mathcal{S}},\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S} |  |\
|  |  | π⁡(𝒂)≥0​∀𝒂∈𝒜\\displaystyle\\pi(\\bm{a})\\geq 0~~~\\forall\\bm{a}\\in\\mathcal{A} |  |\
|  |  | ∑𝒂∈𝒜π⁡(𝒂)=1.\\displaystyle\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi(\\bm{a})=1. |  |\
\
Since\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | 𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)\]=∑𝒂∈𝒜π⁡(𝒂)​𝒰i​(𝒂^S,𝒂−S)\\displaystyle\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)\\right\]=\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi(\\bm{a})\\mathcal{U}\_{i}(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}) |  |\
|  |  | 𝔼𝒂∼π​\[𝒰i​(𝒂)\]=∑𝒂∈𝒜π⁡(𝒂)​𝒰i​(𝒂)\\displaystyle\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]=\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi(\\bm{a})\\mathcal{U}\_{i}(\\bm{a}) |  |\
\
are linear in π\\pi, the linear programming above is valid. Note that the linear program contains exponentially many variables (π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}}), so its complexity is necessarily exponential in NN.\
\
## Appendix B Omitted Proofs in [Section5](https://arxiv.org/html/2604.28186v1\#S5 "5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
See [5.1](https://arxiv.org/html/2604.28186v1#S5.theoremcounter1 "Lemma 5.1 (Non-existence of Coalition-Proof CCE). ‣ Distinction between coalition-proof and strong CCE. ‣ 5 Relations among Equilibria ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
We construct a counterexample using a variant of the game described by [Bernheim et al. (1987)](https://arxiv.org/html/2604.28186v1#bib.bib8 ""). Consider three players dividing five coins. Each player ii chooses an action from the set of all possible strict rankings over the players, 𝒜i={(P1≻P2≻P3),…,(P3≻P2≻P1)}\\mathcal{A}\_{i}=\\left\\{(P\_{1}\\succ P\_{2}\\succ P\_{3}),\\dots,(P\_{3}\\succ P\_{2}\\succ P\_{1})\\right\\}. If two or more players vote for the same ranking, the payoffs are distributed according to that ranking: the first-ranked player receives 3 coins, the second-ranked player receives 2 coins, and the third-ranked player receives 0. If no majority agreement is reached ( _i.e._, all three players vote for distinct rankings), all players receive 0.\
\
Let π∗\\pi^{\*} be any CCE of this game. By definition, any coalition-proof CCE must also be a CCE. We prove the non-existence of a coalition-proof CCE by demonstrating that any valid CCE π∗\\pi^{\*} admits a self-enforcing deviation by a coalition.\
\
Assume without loss of generality that the expected utilities of players 1, 2, and 3 are non-increasing:\
\
|     |     |     |\
| --- | --- | --- |\
|  | 𝔼𝒂∼π∗​\[𝒰1​(𝒂)\]≥𝔼𝒂∼π∗​\[𝒰2​(𝒂)\]≥𝔼𝒂∼π∗​\[𝒰3​(𝒂)\].\\displaystyle\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\*}}\\left\[\\mathcal{U}\_{1}(\\bm{a})\\right\]\\geq\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\*}}\\left\[\\mathcal{U}\_{2}(\\bm{a})\\right\]\\geq\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\*}}\\left\[\\mathcal{U}\_{3}(\\bm{a})\\right\]. |  |\
\
Consider the coalition S={2,3}S=\\left\\{2,3\\right\\} and a deviation strategy where both members deterministically vote for the ranking P2≻P3≻P1P\_{2}\\succ P\_{3}\\succ P\_{1}. Under this deviation, players 2 and 3 form a majority regardless of player 1’s action, guaranteeing themselves payoffs of 3 and 2, respectively. This deviation is both valid and self-enforcing:\
\
1. 1.\
\
\
Improvement: The total sum of utilities in any outcome is at most 5. Given the non-increasing order of utilities, it must hold that player 2’s original expected utility is strictly less than 3 (𝔼𝒂∼π∗​\[𝒰2​(𝒂)\]<3\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\*}}\\left\[\\mathcal{U}\_{2}(\\bm{a})\\right\]<3) and player 3’s is strictly less than 2 (𝔼𝒂∼π∗​\[𝒰3​(𝒂)\]<2\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\*}}\\left\[\\mathcal{U}\_{3}(\\bm{a})\\right\]<2). Thus, the deviation strictly improves the payoff for both coalition members.\
\
2. 2.\
\
\
Self-Enforcement: The deviation constitutes a coalition-proof CCE in the reduced game restricted to coalition SS. Player 2 has no incentive to deviate further, as player 2 already achieves the maximum possible utility of 3 coins. Player 3 also has no incentive to deviate. Any further deviation by Player 3 breaks the agreement with Player 2; thus, Player 3 can only accrue positive utility by matching Player 1’s strategy, π1∗\\pi^{\*}\_{1}. However, if coordinating with π1∗\\pi^{\*}\_{1} were to yield a utility strictly greater than 2, Player 3 would have had a profitable unilateral deviation from the original equilibrium π∗\\pi^{\*}. This contradicts the assumption that π∗\\pi^{\*} is a CCE.\
\
\
Since there exists a valid, self-enforcing deviation for the coalition {2,3}\\left\\{2,3\\right\\}, π∗\\pi^{\*} cannot be a coalition-proof CCE. As this holds for any CCE π∗\\pi^{\*}, no coalition-proof CCE exists in this game. ∎\
\
## Appendix C Omitted Proofs in [Section6](https://arxiv.org/html/2604.28186v1\#S6 "6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
This section presents the omitted proofs in [Section6](https://arxiv.org/html/2604.28186v1#S6 "6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
### C.1 Proof of [Theorem6.1](https://arxiv.org/html/2604.28186v1\#S6.theoremcounter1 "Theorem 6.1. ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
See [6.1](https://arxiv.org/html/2604.28186v1#S6.theoremcounter1 "Theorem 6.1. ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
We will introduce the allocation problem (NP-hard) and show that it can be reduced to computing the correlated strong equilibrium.\
\
###### Definition C.1(Allocation Problem).\
\
There are nn agents and mm goods. An assignment X:\[m\]→\[n\]X\\colon\[m\]\\to\[n\] is a mapping from each good to an agent. Agent ii’s utility is ui​(X)u\_{i}(X) for an assignment XX. A stochastic allocation 𝒑∈Δ\[m\]\[n\]\\bm{p}\\in\\Delta^{\[m\]^{\[n\]}} is a distribution over all possible assignments. The egalitarian social welfare (ESW) maximization is defined as\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | max𝒑∈Δ\[m\]\[n\]⁡min⁡∑X∈\[m\]\[n\]i∈\[n\]⁡p⁡(X)​ui​(X).\\displaystyle\\max\_{\\bm{p}\\in\\Delta^{\[m\]^{\[n\]}}}\\min\_{i\\in\[n\]}\\sum\_{X\\in\[m\]^{\[n\]}}p(X)u\_{i}(X). |  | (C.1) |\
\
For any allocation problem, we can create a game with N=n+mN=n+m players. The action set of player i≤ni\\leq n is 𝒜i={0,1}\\mathcal{A}\_{i}=\\left\\{0,1\\right\\}, while the action set of player j>nj>n is 𝒜j=\[n\]\\mathcal{A}\_{j}=\[n\]. For any joint action 𝒂∈𝒜\\bm{a}\\in\\mathcal{A}, 𝒰i​(𝒂)=ui​(𝒂−\[n\])\\mathcal{U}\_{i}(\\bm{a})=u\_{i}(\\bm{a}\_{-\[n\]}) for i≤ni\\leq n when a1=a2=⋯=ana\_{1}=a\_{2}=\\dots=a\_{n}, otherwise 𝒰i​(𝒂)=−ui​(𝒂−\[n\])\\mathcal{U}\_{i}(\\bm{a})=-u\_{i}(\\bm{a}\_{-\[n\]}). For j>nj>n, 𝒰j​(𝒂)=0\\mathcal{U}\_{j}(\\bm{a})=0. Moreover, let 𝒮={{1},{2},…,{n}}{\\mathcal{S}}=\\left\\{\\left\\{1\\right\\},\\left\\{2\\right\\},\\dots,\\left\\{n\\right\\}\\right\\}. We further define\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | a≔\\displaystyle a\\coloneqq | ∑𝒂∈𝒜:a2=a3=⋯=an=0π(𝒂)ui(𝒂−\[n\])\\displaystyle\\sum\_{\\begin{subarray}{c}\\bm{a}\\in\\mathcal{A}\\colon\\\<br>a\_{2}=a\_{3}=\\dots=a\_{n}=0\\end{subarray}}\\pi(\\bm{a})u\_{i}\\left(\\bm{a}\_{-\[n\]}\\right) |  |\
|  | b≔\\displaystyle b\\coloneqq | ∑𝒂∈𝒜:a2=a3=⋯=an=1π(𝒂)ui(𝒂−\[n\])\\displaystyle\\sum\_{\\begin{subarray}{c}\\bm{a}\\in\\mathcal{A}\\colon\\\<br>a\_{2}=a\_{3}=\\dots=a\_{n}=1\\end{subarray}}\\pi(\\bm{a})u\_{i}\\left(\\bm{a}\_{-\[n\]}\\right) |  |\
|  | c≔\\displaystyle c\\coloneqq | −∑𝒂∈𝒜:∃i,j∈\[n\]∖{1},ai≠ajπ(𝒂)ui(𝒂−\[n\]).\\displaystyle-\\sum\_{\\begin{subarray}{c}\\bm{a}\\in\\mathcal{A}\\colon\\\<br>\\exists i,j\\in\[n\]\\setminus\\left\\{1\\right\\},a\_{i}\\not=a\_{j}\\end{subarray}}\\pi(\\bm{a})u\_{i}\\left(\\bm{a}\_{-\[n\]}\\right). |  |\
\
Then, the gap of player 11 is lower bounded by\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | maxa^1∈{0,1}⁡𝔼𝒂∼π​\[𝒰i​(a^1,𝒂−1)−𝒰i​(𝒂)\]≥\\displaystyle\\max\_{\\widehat{a}\_{1}\\in\\left\\{0,1\\right\\}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{a}\_{1},\\bm{a}\_{-1}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]\\geq | max⁡(a,b)+c−(a+b+c)=−min⁡(a,b).\\displaystyle\\max\\left(a,b\\right)+c-(a+b+c)=-\\min\\left(a,b\\right). |  |\
\
The equation holds when a1a\_{1} is always equal to a2a\_{2} when a2=a3=⋯=ana\_{2}=a\_{3}=\\dots=a\_{n}.\
Therefore, the optimal strategy π\\pi should satisfy π\[n\]​((0,…​0))=π\[n\]​((1,…​1))=12\\pi\_{\[n\]}((0,\\dots 0))=\\pi\_{\[n\]}((1,\\dots 1))=\\frac{1}{2}.\
\
Then, [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation") is equivalent to\
\
|     |     |     |\
| --- | --- | --- |\
|  | minπ\[m\]∈Δ\[m\]\[n\]maxi∈\[n\]∑𝒂∈𝒜−π(𝒂)ui(𝒂−\[n\])=minπ\[m\]∈Δ\[m\]\[n\]maxi∈\[n\]∑𝒂−\[n\]∈\[m\]\[n\]−π−\[n\](𝒂−\[n\])ui(𝒂−\[n\]),\\displaystyle\\min\_{\\pi\_{\[m\]}\\in\\Delta^{\[m\]^{\[n\]}}}\\max\_{i\\in\[n\]}\\sum\_{\\bm{a}\\in\\mathcal{A}}-\\pi(\\bm{a})u\_{i}(\\bm{a}\_{-\[n\]})=\\min\_{\\pi\_{\[m\]}\\in\\Delta^{\[m\]^{\[n\]}}}\\max\_{i\\in\[n\]}\\sum\_{\\bm{a}\_{-\[n\]}\\in\[m\]^{\[n\]}}-\\pi\_{-\[n\]}(\\bm{a}\_{-\[n\]})u\_{i}(\\bm{a}\_{-\[n\]}), |  |\
\
which is equivalent to [C.1](https://arxiv.org/html/2604.28186v1#A3.E1 "In Definition C.1 (Allocation Problem). ‣ Proof. ‣ C.1 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation"). Finally, according to [Kawase and Sumita (2020, Corollary 1)](https://arxiv.org/html/2604.28186v1#bib.bib29 ""), it is NP-hard to approximate [C.1](https://arxiv.org/html/2604.28186v1#A3.E1 "In Definition C.1 (Allocation Problem). ‣ Proof. ‣ C.1 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation") up to 1−1e1-\\frac{1}{e}.\
\
The hard instance constructed in [Kawase and Sumita (2020)](https://arxiv.org/html/2604.28186v1#bib.bib29 "") satisfies that maxi⁡maxX∈\[m\]\[n\]​ui​(X)=P​o​l​y​(n,m)\\max\_{i}\\max\_{X\\in\[m\]^{\[n\]}}u\_{i}(X)=Poly(n,m) and the solution to [C.1](https://arxiv.org/html/2604.28186v1#A3.E1 "In Definition C.1 (Allocation Problem). ‣ Proof. ‣ C.1 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation") is 11. Therefore, Poly​(N,1ϵ)\\text{Poly}(N,\\frac{1}{\\epsilon}) algorithm does not exist unless P=NP for solving an ϵ\\epsilon-MASE.\
∎\
\
### C.2 Proof of [Theorem6.3](https://arxiv.org/html/2604.28186v1\#S6.theoremcounter3 "Theorem 6.3 (Treewidth). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
See [6.3](https://arxiv.org/html/2604.28186v1#S6.theoremcounter3 "Theorem 6.3 (Treewidth). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
According to [Lokshtanov et al. (2011)](https://arxiv.org/html/2604.28186v1#bib.bib31 ""), under SETH, qq-coloring cannot be solved in 𝒪⁡((q−ζ)tw⋅Poly​(\|I\|))\\mathcal{O}((q-\\zeta)^{\\rm tw}\\cdot\\text{Poly}(\|I\|)) for arbitrary graph GG, when a tree decomposition of width t​wtw is given.111111\
\
\
\
\
\
\
\
As summarized in [Esmer et al. (2024)](https://arxiv.org/html/2604.28186v1#bib.bib20 ""), the proof of the qq-coloring complexity implicitly implies that the complexity is lower bounded by 𝒪⁡(qt​w⋅Poly​(\|I\|))\\mathcal{O}(q^{tw}\\cdot\\text{Poly}(\|I\|)), even though a tree decomposition of width t​wtw is given. In other words, aside from computing a tree decomposition, the qq-coloring itself has an intrinsic computational barrier. In the sequel, we construct a game such that computing 1N\\frac{1}{N}-approximate [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation") is equivalent to determining the qq-coloring.\
\
For any qq-coloring problem on G=(V,E)G=(V,E), we will construct a game with N=\|V\|+\|E\|N=\|V\|+\|E\| players. For each player i≤\|V\|i\\leq\|V\|, the action set 𝒜i={1,2,…,q}\\mathcal{A}\_{i}=\\left\\{1,2,\\dots,q\\right\\} and the utility function 𝒰i≡0\\mathcal{U}\_{i}\\equiv 0 is a constant function equal to zero. For each player j>\|V\|j>\|V\|, the action set is {1}\\left\\{1\\right\\} and the utility function is 𝒰j​(𝒂)=𝟙(aej−\|V\|,1≠aej−\|V\|,2)\\mathcal{U}\_{j}(\\bm{a})=\\ind\\left(a\_{e\_{j-\|V\|,1}}\\not=a\_{e\_{j-\|V\|,2}}\\right), where (ej−\|V\|,1,ej−\|V\|,2)(e\_{j-\|V\|,1},e\_{j-\|V\|,2}) is the (j−\|V\|)t​h(j-\|V\|)^{th} edge in EE and 𝟙\\ind is the indicator function (equals one when the argument is true and otherwise zero). In this game, 𝒮={{i1,i2,j+\|V\|}\|ej=(i1,i2)}{\\mathcal{S}}=\\left\\{\\left\\{i\_{1},i\_{2},j+\|V\|\\right\\}{\\,\|\\,}e\_{j}=(i\_{1},i\_{2})\\right\\}.\
\
Firstly, for any proper coloring 𝒄∈\[q\]\|V\|\\bm{c}\\in\[q\]^{\|V\|}, the associated pure strategy is π𝒄\\pi^{\\bm{c}}, where πi𝒄​(ai)=1\\pi\_{i}^{\\bm{c}}(a\_{i})=1 if and only if ai=cia\_{i}=c\_{i} and 00 otherwise. It satisfies [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation"). Because for any 𝒮∋S=(i1,i2,j+\|V\|){\\mathcal{S}}\\ni S=(i\_{1},i\_{2},j+\|V\|), the maximum of 1\|S\|​∑i∈S𝒰i​(π)\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathcal{U}\_{i}(\\pi) is 13\\frac{1}{3}, which is attained when the colors of node i1,i2i\_{1},i\_{2} are different. Therefore, π𝒄\\pi^{\\bm{c}} obtains the maximum for every coalition S∈𝒮S\\in{\\mathcal{S}}, which implies the satisfaction of [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
Secondly, for any joint strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}} satisfying [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation"), we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | minS∈𝒮⁡∑i∈S𝒰i​(π)\|S\|≤1\|𝒮\|​∑S∈𝒮∑i∈S𝒰i​(π)\|S\|=\\displaystyle\\min\_{S\\in{\\mathcal{S}}}\\frac{\\sum\_{i\\in S}\\mathcal{U}\_{i}(\\pi)}{\|S\|}\\leq\\frac{1}{\|{\\mathcal{S}}\|}\\sum\_{S\\in{\\mathcal{S}}}\\frac{\\sum\_{i\\in S}\\mathcal{U}\_{i}(\\pi)}{\|S\|}= | ∑𝒂∈𝒜π⁡(𝒂)​1\|𝒮\|​∑S∈𝒮∑i∈S𝒰i​(𝒂)\|S\|\\displaystyle\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi(\\bm{a})\\frac{1}{\|{\\mathcal{S}}\|}\\sum\_{S\\in{\\mathcal{S}}}\\frac{\\sum\_{i\\in S}\\mathcal{U}\_{i}(\\bm{a})}{\|S\|} |  |\
|  | ≤\\displaystyle\\leq | 13−13​\|E\|∑𝒂∈𝒜π(𝒂)𝟙(𝐚\[\|V\|\] is not a proper coloring).\\displaystyle\\frac{1}{3}-\\frac{1}{3\|E\|}\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi(\\bm{a})\\ind\\left(\\bm{a}\_{\[\|V\|\]}\\text{ is not a proper coloring}\\right). |  |\
\
Because there must exist at least one edge with both of its nodes in the same color for any improper coloring. On the other hand, let π^=π𝒄\\widehat{\\pi}=\\pi^{\\bm{c}} for some proper coloring 𝒄\\bm{c}. Then, for any S∈𝒮S\\in{\\mathcal{S}}, we have\
\
|     |     |     |\
| --- | --- | --- |\
|  | ∑i∈S𝒰i​(π^)\|S\|=13.\\displaystyle\\frac{\\sum\_{i\\in S}\\mathcal{U}\_{i}(\\widehat{\\pi})}{\|S\|}=\\frac{1}{3}. |  |\
\
Therefore, the approximation error of [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation") is at least\
\
|     |     |     |\
| --- | --- | --- |\
|  | 13​\|E\|∑𝒂∈𝒜π(𝒂)𝟙(𝐚\[\|V\|\] is not a proper coloring)\\displaystyle\\frac{1}{3\|E\|}\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi(\\bm{a})\\ind\\left(\\bm{a}\_{\[\|V\|\]}\\text{ is not a proper coloring}\\right) |  |\
\
for any joint strategy π\\pi. When we get 19​N2\\frac{1}{9N^{2}} approximation, since \|E\|≤N2\|E\|\\leq N^{2}, we have\
\
|     |     |     |\
| --- | --- | --- |\
|  | ∑𝒂∈𝒜π(𝒂)𝟙(𝐚\[\|V\|\] is not a proper coloring)≤13.\\displaystyle\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi(\\bm{a})\\ind\\left(\\bm{a}\_{\[\|V\|\]}\\text{ is not a proper coloring}\\right)\\leq\\frac{1}{3}. |  |\
\
Therefore, when sampling 𝒂∼π\\bm{a}\\sim\\pi, we will get a proper coloring with probability at least 23\\frac{2}{3}, which is in complexity class RP. As a result, when P=RP, the time complexity of computing [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation") is at least O∗​(At​w​(G))O^{\*}(A^{tw(G)}), where GG is the trust graph and AA is the size of the maximal action set.\
∎\
\
### C.3 Proof of [Theorem6.4](https://arxiv.org/html/2604.28186v1\#S6.theoremcounter4 "Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
See [6.4](https://arxiv.org/html/2604.28186v1#S6.theoremcounter4 "Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
The proof is inspired by [Borgs et al. (2010, Theorem 1)](https://arxiv.org/html/2604.28186v1#bib.bib10 ""), who showed that approximating\
\
|     |     |     |\
| --- | --- | --- |\
|  | minπ1∈Δ𝒜1⁡minπ2∈Δ𝒜2​maxπ3∈Δ𝒜3​𝔼𝒂∼(π1,π2,π3)​\[𝒰3​(𝒂)\]\\displaystyle\\min\_{\\pi\_{1}\\in\\Delta^{\\mathcal{A}\_{1}}}\\min\_{\\pi\_{2}\\in\\Delta^{\\mathcal{A}\_{2}}}\\max\_{\\pi\_{3}\\in\\Delta^{\\mathcal{A}\_{3}}}\\mathbb{E}\_{\\bm{a}\\sim(\\pi\_{1},\\pi\_{2},\\pi\_{3})}\\left\[\\mathcal{U}\_{3}(\\bm{a})\\right\] |  |\
\
is NP-hard via a reduction from 3-colorability.\
\
We similarly reduce 3-colorability to the problem of finding an approximate [Minimum Strong CCE](https://arxiv.org/html/2604.28186v1#S6.Ex1 "In Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). Given any graph G=(V,E)G=(V,E) with \|V\|≥4\|V\|\\geq 4, we construct a game with N=3​\|V\|+2N=3\|V\|+2 players and 𝒮={S}{\\mathcal{S}}=\\left\\{S\\right\\}, where S={1,2,…,3​\|V\|,3​\|V\|+2}S=\\left\\{1,2,\\dots,3\|V\|,3\|V\|+2\\right\\}. Thus, there is only a single coalition of interest. The objective of strong CCE is therefore\
\
|     |     |     |     |     |\
| --- | --- | --- | --- | --- |\
|  |  | minπ∈Δ𝒜⁡maxπ^S∈Δ𝒜S​mini∈S​𝔼𝒂∼π,𝒂^S∼π^S​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\min\_{\\pi\\in\\Delta^{\\mathcal{A}}}~\\max\_{\\widehat{\\pi}\_{S}\\in\\Delta^{\\mathcal{A}\_{S}}}~\\min\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi,\\widehat{\\bm{a}}\_{S}\\sim\\widehat{\\pi}\_{S}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | ⇔(i)\\displaystyle\\overset{(i)}{\\Leftrightarrow} | minπ∈Δ𝒜⁡maxπ^S∈Δ𝒜S​min⁡∑i∈S𝜶∈Δ𝒮⁡αi​𝔼𝒂∼π,𝒂^S∼π^S​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\min\_{\\pi\\in\\Delta^{\\mathcal{A}}}~\\max\_{\\widehat{\\pi}\_{S}\\in\\Delta^{\\mathcal{A}\_{S}}}~\\min\_{\\bm{\\alpha}\\in\\Delta^{{\\mathcal{S}}}}\\sum\_{i\\in S}\\alpha\_{i}~\\mathbb{E}\_{\\bm{a}\\sim\\pi,\\widehat{\\bm{a}}\_{S}\\sim\\widehat{\\pi}\_{S}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | ⇔(i​i)\\displaystyle\\overset{(ii)}{\\Leftrightarrow} | minπ∈Δ𝒜⁡min𝜶∈Δ𝒮​max⁡∑i∈Sπ^S∈Δ𝒜S⁡αi​𝔼𝒂∼π,𝒂^S∼π^S​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\].\\displaystyle\\min\_{\\pi\\in\\Delta^{\\mathcal{A}}}~\\min\_{\\bm{\\alpha}\\in\\Delta^{{\\mathcal{S}}}}~\\max\_{\\widehat{\\pi}\_{S}\\in\\Delta^{\\mathcal{A}\_{S}}}\\sum\_{i\\in S}\\alpha\_{i}~\\mathbb{E}\_{\\bm{a}\\sim\\pi,\\widehat{\\bm{a}}\_{S}\\sim\\widehat{\\pi}\_{S}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]. |  | (C.2) |\
\
(i)(i) holds because\
\
|     |     |     |\
| --- | --- | --- |\
|  | ∑i∈Sαi​𝔼𝒂∼π,𝒂^S∼π^S​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\sum\_{i\\in S}\\alpha\_{i}~\\mathbb{E}\_{\\bm{a}\\sim\\pi,\\widehat{\\bm{a}}\_{S}\\sim\\widehat{\\pi}\_{S}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
\
is linear in 𝜶\\bm{\\alpha}, so the minimum is attained at an extreme point. In other words, 𝜶\\bm{\\alpha} places all of its mass on a single player in SS. (i​i)(ii) follows from the minimax theorem.\
\
Intuitively, we construct the game so that π\\pi, 𝜶\\bm{\\alpha}, and π^S\\widehat{\\pi}\_{S} correspond to the strategies of three different agents. Agent 1 and agent 2 each choose a vertex in VV together with a color in \[3\]\[3\]. Agent 3 then chooses either agent 1 or agent 2 and tries to predict the vertex selected by that agent. We will show that, under the utility functions defined below, the value of [C.2](https://arxiv.org/html/2604.28186v1#A3.E2 "In Proof. ‣ C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation") differs depending on whether GG is 3-colorable. Consequently, if we can approximate this value with sufficient accuracy, then we can decide whether GG is 3-colorable.\
\
The action sets of the game are defined by\
\
|     |     |     |\
| --- | --- | --- |\
|  | 𝒜i={3​\|V\|i=3​\|V\|+12​\|V\|i=3​\|V\|+21i≤3​\|V\|,\\displaystyle\\mathcal{A}\_{i}=\\begin{cases}3\|V\|&i=3\|V\|+1\\\<br>2\|V\|&i=3\|V\|+2\\\<br>1&i\\leq 3\|V\|,\\end{cases} |  |\
\
for all i∈\[N\]i\\in\[N\]. Hence, every joint action can be written as ((v1,c1),(v3,i3))((v\_{1},c\_{1}),(v\_{3},i\_{3})), where v1,v3∈Vv\_{1},v\_{3}\\in V, c1∈\[3\]c\_{1}\\in\[3\], and i3∈\[2\]i\_{3}\\in\[2\]. Thus, agent 1 proposes a vertex v1v\_{1} together with a color c1c\_{1}, while agent 3 predicts that player i3i\_{3} proposed vertex v3v\_{3}. In addition, for each player i≤3​\|V\|i\\leq 3\|V\|, we encode its index as (v2,c2)(v\_{2},c\_{2}) with v2∈Vv\_{2}\\in V and c2∈\[3\]c\_{2}\\in\[3\]. This represents the proposal of agent 2. For any joint action ((v1,c1),(v3,i3))((v\_{1},c\_{1}),(v\_{3},i\_{3})), the utility functions are defined by\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | 𝒰3​\|V\|+1​(((v1,c1),(v3,i3)))=𝒰3​\|V\|+2​(((v1,c1),(v3,i3)))=1\\displaystyle\\mathcal{U}\_{3\|V\|+1}\\left(((v\_{1},c\_{1}),(v\_{3},i\_{3}))\\right)=\\mathcal{U}\_{3\|V\|+2}\\left(((v\_{1},c\_{1}),(v\_{3},i\_{3}))\\right)=1 |  |\
|  |  | 𝒰(v2,c2)​(((v1,c1),(v3,i3)))={1v1=v2,c1≠c21(v1,v2)∈E,c1=c21vi3=v30Otherwise.\\displaystyle\\mathcal{U}\_{(v\_{2},c\_{2})}\\left(((v\_{1},c\_{1}),(v\_{3},i\_{3}))\\right)=\\begin{cases}1&v\_{1}=v\_{2},~~c\_{1}\\neq c\_{2}\\\<br>1&(v\_{1},v\_{2})\\in E,~~c\_{1}=c\_{2}\\\<br>1&v\_{i\_{3}}=v\_{3}\\\<br>0&\\text{Otherwise.}\\end{cases} |  |\
\
In words, a player receives a reward 11 whenever the proposals of agents 1 and 2 are inconsistent, or whenever agent 3 makes a correct prediction. Hence, in the corresponding [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), the edge set is\
\
|     |     |     |\
| --- | --- | --- |\
|  | ℰ={(i,3​\|V\|+1)}i=13​\|V\|∪{(i,3​\|V\|+2)}i=13​\|V\|∪{(3​\|V\|+1,3​\|V\|+2)}.\\displaystyle\\mathcal{E}=\\left\\{(i,3\|V\|+1)\\right\\}\_{i=1}^{3\|V\|}\\cup\\left\\{(i,3\|V\|+2)\\right\\}\_{i=1}^{3\|V\|}\\cup\\left\\{(3\|V\|+1,3\|V\|+2)\\right\\}. |  |\
\
In other words, every one of the first 3​\|V\|3\|V\| vertices is adjacent to both 3​\|V\|+13\|V\|+1 and 3​\|V\|+23\|V\|+2, and these latter two vertices are also adjacent. Hence, the resulting graph has treewidth 22.\
\
Now fix any joint action ((v1,c1),(v3,i3))((v\_{1},c\_{1}),(v\_{3},i\_{3})). We can factor\
\
|     |     |     |\
| --- | --- | --- |\
|  | π⁡(((v1,c1),(v3,i3)))=π−S​((v1,c1))​πS​((v3,i3)\|(v1,c1)),\\displaystyle\\pi(((v\_{1},c\_{1}),(v\_{3},i\_{3})))=\\pi\_{-S}((v\_{1},c\_{1}))\\,\\pi\_{S}((v\_{3},i\_{3}){\\,\|\\,}(v\_{1},c\_{1})), |  |\
\
and only the second factor πS​((v3,i3)\|(v1,c1))\\pi\_{S}((v\_{3},i\_{3}){\\,\|\\,}(v\_{1},c\_{1})) affects the term 𝒰i​(𝒂)\\mathcal{U}\_{i}(\\bm{a}) in [C.2](https://arxiv.org/html/2604.28186v1#A3.E2 "In Proof. ‣ C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation"). Since π\\pi is maximizing 𝒰i​(𝒂)\\mathcal{U}\_{i}(\\bm{a}), we may always choose\
\
|     |     |     |\
| --- | --- | --- |\
|  | πS​((v3,i3)\|(v1,c1))=𝟙(v1=v3​ and ​i3=1).\\displaystyle\\pi\_{S}((v\_{3},i\_{3}){\\,\|\\,}(v\_{1},c\_{1}))=\\ind\\left(v\_{1}=v\_{3}\\text{ and }i\_{3}=1\\right). |  |\
\
Therefore, for every i≤3​\|V\|i\\leq 3\|V\|, we have 𝒰i​(𝒂)=1\\mathcal{U}\_{i}(\\bm{a})=1 in [C.2](https://arxiv.org/html/2604.28186v1#A3.E2 "In Proof. ‣ C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation"). For i>3​\|V\|i>3\|V\|, we also have 𝒰i​(𝒂)=1\\mathcal{U}\_{i}(\\bm{a})=1 by definition of the utility functions. Thus, 𝒰i​(𝒂)\\mathcal{U}\_{i}(\\bm{a}) is constant in [C.2](https://arxiv.org/html/2604.28186v1#A3.E2 "In Proof. ‣ C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation") and can be removed from the optimization objective. We may therefore rewrite the objective as\
\
|     |     |     |     |     |\
| --- | --- | --- | --- | --- |\
|  |  | minπ−S∈Δ𝒜−S⁡min𝜶∈Δ𝒮​max⁡∑i∈Sπ^S∈Δ𝒜S⁡αi​𝔼𝒂−S∼π−S,𝒂^S∼π^S​\[𝒰i​(𝒂^S,𝒂−S)\]\\displaystyle\\min\_{\\pi\_{-S}\\in\\Delta^{\\mathcal{A}\_{-S}}}~\\min\_{\\bm{\\alpha}\\in\\Delta^{{\\mathcal{S}}}}~\\max\_{\\widehat{\\pi}\_{S}\\in\\Delta^{\\mathcal{A}\_{S}}}\\sum\_{i\\in S}\\alpha\_{i}~\\mathbb{E}\_{\\bm{a}\_{-S}\\sim\\pi\_{-S},\\widehat{\\bm{a}}\_{S}\\sim\\widehat{\\pi}\_{S}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)\\right\] |  |\
|  | ⇔(i)\\displaystyle\\overset{(i)}{\\Leftrightarrow} | minπ−S∈Δ𝒜−S⁡min𝜶∈Δ\[3​\|V\|\]​max⁡∑i=13​\|V\|π^S∈Δ𝒜S⁡αi​𝔼𝒂−S∼π−S,𝒂^S∼π^S​\[𝒰i​(𝒂^S,𝒂−S)\].\\displaystyle\\min\_{\\pi\_{-S}\\in\\Delta^{\\mathcal{A}\_{-S}}}~\\min\_{\\bm{\\alpha}\\in\\Delta^{\[3\|V\|\]}}~\\max\_{\\widehat{\\pi}\_{S}\\in\\Delta^{\\mathcal{A}\_{S}}}\\sum\_{i=1}^{3\|V\|}\\alpha\_{i}~\\mathbb{E}\_{\\bm{a}\_{-S}\\sim\\pi\_{-S},\\widehat{\\bm{a}}\_{S}\\sim\\widehat{\\pi}\_{S}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)\\right\]. |  | (C.3) |\
\
(i)(i) holds because 𝒰i​(𝒂)=1\\mathcal{U}\_{i}(\\bm{a})=1 for every 𝒂∈𝒜\\bm{a}\\in\\mathcal{A} whenever i>3​\|V\|i>3\|V\|. Hence, we may assume without loss of generality that α⁡(3​\|V\|+2)=0\\alpha(3\|V\|+2)=0, since 𝒰j​(𝒂)≤𝒰i​(𝒂)=1\\mathcal{U}\_{j}(\\bm{a})\\leq\\mathcal{U}\_{i}(\\bm{a})=1 for any 𝒂∈𝒜\\bm{a}\\in\\mathcal{A}, i>3​\|V\|i>3\|V\|, and j≤3​\|V\|j\\leq 3\|V\|.\
\
We now analyze [C.3](https://arxiv.org/html/2604.28186v1#A3.E3 "In Proof. ‣ C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation"). First, it is always at least 1\|V\|\\frac{1}{\|V\|}, because π^S\\widehat{\\pi}\_{S} (agent 3) can choose i3=1i\_{3}=1 and select a vertex v3∈Vv\_{3}\\in V uniformly at random. Then,\
\
|     |     |     |\
| --- | --- | --- |\
|  | Pr(v1,c1)∼π−S,(v3,i3)∼π^S⁡(v1=v3)=∑v∈V(∑c1=13π−S​((v,c1)))​π^S​((v,1))=1\|V\|​∑v∈V∑c1=13π−S​((v,c1))=1\|V\|.\\displaystyle\\Pr\_{(v\_{1},c\_{1})\\sim\\pi\_{-S},(v\_{3},i\_{3})\\sim\\widehat{\\pi}\_{S}}(v\_{1}=v\_{3})=\\sum\_{v\\in V}\\left(\\sum\_{c\_{1}=1}^{3}\\pi\_{-S}((v,c\_{1}))\\right)\\widehat{\\pi}\_{S}((v,1))=\\frac{1}{\|V\|}\\sum\_{v\\in V}\\sum\_{c\_{1}=1}^{3}\\pi\_{-S}((v,c\_{1}))=\\frac{1}{\|V\|}. |  |\
\
If GG is 3-colorable, then [C.3](https://arxiv.org/html/2604.28186v1#A3.E3 "In Proof. ‣ C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation") is exactly 1\|V\|\\frac{1}{\|V\|}: agent 1, represented by π−S\\pi\_{-S}, and agent 2, represented by 𝜶\\bm{\\alpha}, both choose a uniformly random vertex and then assign to that vertex the color given by the same valid 3-coloring. Under this choice, the proposals of agents 1 and 2 are always consistent. Therefore, the only way for a utility term to equal 11 is for agent 3 to predict the chosen vertex correctly, which occurs with probability exactly 1\|V\|\\frac{1}{\|V\|}.\
\
In contrast, suppose that GG is not 3-colorable. If either agent 1 or agent 2 assigns probability at least 1\|V\|+13​\|V\|2\\frac{1}{\|V\|}+\\frac{1}{3\|V\|^{2}} to some vertex, then [C.3](https://arxiv.org/html/2604.28186v1#A3.E3 "In Proof. ‣ C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation") is at least 1\|V\|+13​\|V\|2\\frac{1}{\|V\|}+\\frac{1}{3\|V\|^{2}} by letting agent 3 guessing that vertex deterministically.\
\
It remains to consider the case in which both agent 1 and agent 2 assign a probability at most 1\|V\|+13​\|V\|2\\frac{1}{\|V\|}+\\frac{1}{3\|V\|^{2}} to every vertex. Then, for any v1∈Vv\_{1}\\in V,\
\
|     |     |     |\
| --- | --- | --- |\
|  | ∑c1=13πS​((v1,c1))≥1−(\|V\|−1)​(1\|V\|+13​\|V\|2)≥23​\|V\|,\\displaystyle\\sum\_{c\_{1}=1}^{3}\\pi\_{S}((v\_{1},c\_{1}))\\geq 1-(\|V\|-1)\\left(\\frac{1}{\|V\|}+\\frac{1}{3\|V\|^{2}}\\right)\\geq\\frac{2}{3\|V\|}, |  |\
\
and similarly,\
\
|     |     |     |\
| --- | --- | --- |\
|  | ∑c2=13α⁡((v2,c2))≥23​\|V\|.\\displaystyle\\sum\_{c\_{2}=1}^{3}\\alpha((v\_{2},c\_{2}))\\geq\\frac{2}{3\|V\|}. |  |\
\
Using the shorthand\
\
|     |     |     |\
| --- | --- | --- |\
|  | π−S​(v1)=∑c1=13π−S​((v1,c1))\\displaystyle\\pi\_{-S}(v\_{1})=\\sum\_{c\_{1}=1}^{3}\\pi\_{-S}((v\_{1},c\_{1})) |  |\
\
for the marginal distribution on vertices, and similarly for 𝜶\\bm{\\alpha}, we obtain\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | Pr(v1,c1)∼π−S,(v2,c2)∼𝜶(v1=v2,c1≠c2 or (v1,v2)∈E,c1=c2)\\displaystyle\\Pr\_{(v\_{1},c\_{1})\\sim\\pi\_{-S},(v\_{2},c\_{2})\\sim\\bm{\\alpha}}\\left(v\_{1}=v\_{2},~~c\_{1}\\neq c\_{2}\\text{ or }(v\_{1},v\_{2})\\in E,~~c\_{1}=c\_{2}\\right) |  |\
|  | =\\displaystyle= | ∑v1,v2∈Vπ1(v1)α(v2)Prc1∼π−S(⋅\|v1),c2∼α(⋅\|v2)(v1=v2,c1≠c2 or (v1,v2)∈E,c1=c2)\\displaystyle\\sum\_{v\_{1},v\_{2}\\in V}\\pi\_{1}(v\_{1})\\alpha(v\_{2})\\Pr\_{c\_{1}\\sim\\pi\_{-S}(\\cdot{\\,\|\\,}v\_{1}),c\_{2}\\sim\\alpha(\\cdot{\\,\|\\,}v\_{2})}\\left(v\_{1}=v\_{2},~~c\_{1}\\neq c\_{2}\\text{ or }(v\_{1},v\_{2})\\in E,~~c\_{1}=c\_{2}\\right) |  |\
|  | ≥\\displaystyle\\geq | 49​\|V\|2∑v1,v2∈VPrc1∼π−S(⋅\|v1),c2∼α(⋅\|v2)(v1=v2,c1≠c2 or (v1,v2)∈E,c1=c2\|v1,v2)\\displaystyle\\frac{4}{9\|V\|^{2}}\\sum\_{v\_{1},v\_{2}\\in V}\\Pr\_{c\_{1}\\sim\\pi\_{-S}(\\cdot{\\,\|\\,}v\_{1}),c\_{2}\\sim\\alpha(\\cdot{\\,\|\\,}v\_{2})}\\left(v\_{1}=v\_{2},~~c\_{1}\\neq c\_{2}\\text{ or }(v\_{1},v\_{2})\\in E,~~c\_{1}=c\_{2}{\\,\|\\,}v\_{1},v\_{2}\\right) |  |\
|  | ≥(i)\\displaystyle\\overset{(i)}{\\geq} | 49​\|V\|2.\\displaystyle\\frac{4}{9\|V\|^{2}}. |  |\
\
(i)(i) holds because\
\
|     |     |     |\
| --- | --- | --- |\
|  | ∑v1,v2∈VPrc1∼π−S(⋅\|v1),c2∼α(⋅\|v2)(v1=v2,c1≠c2 or (v1,v2)∈E,c1=c2\|v1,v2)\\displaystyle\\sum\_{v\_{1},v\_{2}\\in V}\\Pr\_{c\_{1}\\sim\\pi\_{-S}(\\cdot{\\,\|\\,}v\_{1}),c\_{2}\\sim\\alpha(\\cdot{\\,\|\\,}v\_{2})}\\left(v\_{1}=v\_{2},~~c\_{1}\\neq c\_{2}\\text{ or }(v\_{1},v\_{2})\\in E,~~c\_{1}=c\_{2}{\\,\|\\,}v\_{1},v\_{2}\\right) |  |\
\
can be interpreted as the expected number of violations over all pairs of coloring plans. Since GG is not 3-colorable, any two coloring plans must contain at least one violation: either they assign different colors to the same vertex, or they assign the same color to two adjacent vertices. Hence, every pair of coloring plans has at least one inconsistency, and therefore, this expectation is at least one.\
\
Finally, let agent 3 guess agent 1’s proposed vertex uniformly at random. Then [C.3](https://arxiv.org/html/2604.28186v1#A3.E3 "In Proof. ‣ C.3 Proof of ‣ Appendix C Omitted Proofs in ‣ Computing Equilibrium beyond Unilateral Deviation") is at least\
\
|     |     |     |\
| --- | --- | --- |\
|  | 49​\|V\|2+(1−49​\|V\|2.)1\|V\|=1\|V\|+49​\|V\|2(1−1\|V\|)≥(i)1\|V\|+13​\|V\|2.\\displaystyle\\frac{4}{9\|V\|^{2}}+\\left(1-\\frac{4}{9\|V\|^{2}}.\\right)\\frac{1}{\|V\|}=\\frac{1}{\|V\|}+\\frac{4}{9\|V\|^{2}}\\left(1-\\frac{1}{\|V\|}\\right)\\overset{(i)}{\\geq}\\frac{1}{\|V\|}+\\frac{1}{3\|V\|^{2}}. |  |\
\
(i)(i) holds whenever \|V\|≥4\|V\|\\geq 4. Therefore, if we can approximate [Minimum Strong CCE](https://arxiv.org/html/2604.28186v1#S6.Ex1 "In Theorem 6.4. ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") within 1N2<13​\|V\|2\\frac{1}{N^{2}}<\\frac{1}{3\|V\|^{2}}, then we can decide whether GG is 3-colorable. ∎\
\
## Appendix D Proof of [Theorem7.1](https://arxiv.org/html/2604.28186v1\#S7.theoremcounter1 "Theorem 7.1 (Efficient Representation). ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
See [7.1](https://arxiv.org/html/2604.28186v1#S7.theoremcounter1 "Theorem 7.1 (Efficient Representation). ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
Let D≔∑S∈𝒮∑i∈S\|𝒜S∩𝒩⁡(i)\|D\\coloneqq\\sum\_{S\\in{\\mathcal{S}}}\\sum\_{i\\in S}\\left\|\\mathcal{A}\_{S\\cap\\mathcal{N}(i)}\\right\|. For any joint strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}}, consider the vector 𝒗π∈ℝD\\bm{v}^{\\pi}\\in\\mathbb{R}^{D}, where\
\
|     |     |     |\
| --- | --- | --- |\
|  | vπ​(S,i,𝒂^S∩𝒩⁡(i))=𝔼𝒂∼π​\[𝒰i​(𝒂^S∩𝒩⁡(i),𝒂−(S∩𝒩⁡(i)))−𝒰i​(𝒂)\],\\displaystyle v^{\\pi}(S,i,\\widehat{\\bm{a}}\_{S\\cap\\mathcal{N}(i)})=\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}(\\widehat{\\bm{a}}\_{S\\cap\\mathcal{N}(i)},\\bm{a}\_{-\\left(S\\cap\\mathcal{N}(i)\\right)})-\\mathcal{U}\_{i}(\\bm{a})\\right\], |  |\
\
for any S∈𝒮S\\in{\\mathcal{S}} and 𝒂^S∩𝒩⁡(i)∈𝒜S∩𝒩⁡(i)\\widehat{\\bm{a}}\_{S\\cap\\mathcal{N}(i)}\\in\\mathcal{A}\_{S\\cap\\mathcal{N}(i)}. By definition of 𝒗π\\bm{v}^{\\pi}, it is linear in π\\pi. Therefore, the vertex set of {𝒗π\|π∈Δ𝒜}\\left\\{\\bm{v}^{\\pi}{\\,\|\\,}\\pi\\in\\Delta^{\\mathcal{A}}\\right\\} should correspond to a subset of Δ𝒜\\Delta^{\\mathcal{A}}’s vertex set, which is the set of all pure strategies.\
\
By Carathéodory’s theorem, for any π∗∈Δ𝒜\\pi^{\*}\\in\\Delta^{\\mathcal{A}}, 𝒗π∗\\bm{v}^{\\pi^{\*}} can be represented as the linear combination of D+1D+1 vertices, which further implies it can be written as a linear combination of D+1D+1 vectors in {𝒗π\|π​ is a pure strategy}\\left\\{\\bm{v}^{\\pi}{\\,\|\\,}\\pi\\text{ is a pure strategy}\\right\\}. Then, when 𝒗π∗=∑k=1D+1λk​𝒗πk\\bm{v}^{\\pi^{\*}}=\\sum\_{k=1}^{D+1}\\lambda^{k}\\bm{v}^{\\pi^{k}} with 𝝀∈ΔD+1\\bm{\\lambda}\\in\\Delta^{D+1} and π1,π2,…\\pi^{1},\\pi^{2},\\dots are pure strategies, due to the linearity of 𝒗π\\bm{v}^{\\pi}, we have\
\
|     |     |     |\
| --- | --- | --- |\
|  | 𝒗π∗=∑k=1D+1λk​𝒗πk=𝒗∑k=1D+1λk​πk.\\displaystyle\\bm{v}^{\\pi^{\*}}=\\sum\_{k=1}^{D+1}\\lambda^{k}\\bm{v}^{\\pi^{k}}=\\bm{v}^{\\sum\_{k=1}^{D+1}\\lambda^{k}\\pi^{k}}. |  |\
\
Finally,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =\\displaystyle= | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S∩𝒩⁡(i),𝒂−(S∩𝒩⁡(i)))−𝒰i​(𝒂)\]\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S\\cap\\mathcal{N}(i)},\\bm{a}\_{-(S\\cap\\mathcal{N}(i))}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =\\displaystyle= | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈Svπ∗​(S,i,𝒂^S∩𝒩⁡(i))\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}v^{\\pi^{\*}}(S,i,\\widehat{\\bm{a}}\_{S\\cap\\mathcal{N}(i)}) |  |\
|  | =\\displaystyle= | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈Sv∑k=1D+1λk​πk​(S,i,𝒂^S∩𝒩⁡(i)).\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}v^{\\sum\_{k=1}^{D+1}\\lambda^{k}\\pi^{k}}(S,i,\\widehat{\\bm{a}}\_{S\\cap\\mathcal{N}(i)}). |  |\
\
Hence, once π∗\\pi^{\*} satisfies [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation"), there exists a linear combination of D+1D+1 pure strategies also satisfying [MASE](https://arxiv.org/html/2604.28186v1#S4.Ex1 "In 4 Minimum Average-Strong Equilibrium (MASE) ‣ Computing Equilibrium beyond Unilateral Deviation"). Given 𝒩⁡(i)≤tw⁡(𝒢)\\mathcal{N}(i)\\leq{\\rm tw}(\\mathcal{G}), we have D≤∑S∈𝒮\|S\|⋅Atw⁡(𝒢)D\\leq\\sum\_{S\\in{\\mathcal{S}}}\|S\|\\cdot A^{{\\rm tw}(\\mathcal{G})}.\
∎\
\
## Appendix E The Optimality of Dynamic Programming on Tree Decomposition\
\
This section shows that the dynamic programming ( _e.g._, [7.5](https://arxiv.org/html/2604.28186v1#S7.E5 "In Dynamic programming on the tree. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation")) will compute the optimality. Let ui​(𝒂𝒩⁡(i))u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}) be the contribution of player ii’s utility to the final objective. Recall that 𝒩iS≔𝒩⁡(i)∩S\\mathcal{N}\_{i}^{S}\\coloneqq\\mathcal{N}(i)\\cap S. Then, in [7.5](https://arxiv.org/html/2604.28186v1#S7.E5 "In Dynamic programming on the tree. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"),\
\
|     |     |     |\
| --- | --- | --- |\
|  | ui(𝒂𝒩⁡(i))=−∑τ=1t∑S∈𝒮1\|S\|∑i∈S∑𝒂^𝒩iS∈𝒜𝒩iSμ(τ)(S,𝒂^𝒩iS)(𝒰i(𝒂^𝒩iS,𝒂𝒩⁡(i)∖S)−𝒰i(𝒂𝒩⁡(i)))\\displaystyle u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})=-\\sum\_{\\tau=1}^{t}\\sum\_{S\\in{\\mathcal{S}}}\\frac{1}{\|S\|}\\sum\_{\\begin{subarray}{c}i\\in S\\end{subarray}}~\\sum\_{\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\in\\mathcal{A}\_{\\mathcal{N}\_{i}^{S}}}~\\mu^{(\\tau)}\\left(S,\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\right)\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}},\\bm{a}\_{\\mathcal{N}(i)\\setminus S}\\right)-\\mathcal{U}\_{i}(\\bm{a}\_{\\mathcal{N}(i)})\\right) |  |\
\
at timestep tt. We consider the following update rule in this section, which generalizes [7.5](https://arxiv.org/html/2604.28186v1#S7.E5 "In Dynamic programming on the tree. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") and [G.1](https://arxiv.org/html/2604.28186v1#A7.E1 "In G.1 Efficient Update of 𝜇 ‣ Appendix G Efficient Update of 𝜇 ‣ Computing Equilibrium beyond Unilateral Deviation") (see the proof of [LemmaF.3](https://arxiv.org/html/2604.28186v1#A6.theoremcounter3 "Lemma F.3. ‣ F.3 Sublinear Variation ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation") and [LemmaG.1](https://arxiv.org/html/2604.28186v1#A7.theoremcounter1 "Lemma G.1. ‣ Proof. ‣ G.2 Proof of ‣ Appendix G Efficient Update of 𝜇 ‣ Computing Equilibrium beyond Unilateral Deviation")),\
\
|     |     |     |     |     |\
| --- | --- | --- | --- | --- |\
|  | h⁡(B,𝒂B)=\\displaystyle h(B,\\bm{a}\_{B})= | ∑i∈\[N\]:i​ assigned to ​Bui(𝒂𝒩⁡(i))+∑B′∈C⁡(B)max𝒂B′′∈𝒜B′:𝒂B∩B′=𝒂B∩B′′h(B′,𝒂B′′).\\displaystyle\\sum\_{\\begin{subarray}{c}i\\in\[N\]\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})+\\sum\_{B^{\\prime}\\in C(B)}\\max\_{\\begin{subarray}{c}\\bm{a}\_{B^{\\prime}}^{\\prime}\\in\\mathcal{A}\_{B^{\\prime}}\\colon\\\<br>\\bm{a}\_{B\\cap B^{\\prime}}=\\bm{a}\_{B\\cap B^{\\prime}}^{\\prime}\\end{subarray}}h(B^{\\prime},\\bm{a}\_{B^{\\prime}}^{\\prime}). |  | (E.1) |\
\
In the following, we will show that [E.1](https://arxiv.org/html/2604.28186v1#A5.E1 "In Appendix E The Optimality of Dynamic Programming on Tree Decomposition ‣ Computing Equilibrium beyond Unilateral Deviation") is optimal.\
\
###### Lemma E.1.\
\
For any bag B∈𝒯B\\in{\\mathcal{T}}, let st​(B)≔{i}i​ assigned to ​B∪⋃B′∈C⁡(B)st​(B′)\\text{st}(B)\\coloneqq\\left\\{i\\right\\}\_{i\\text{ assigned to }B}\\cup\\bigcup\_{B^{\\prime}\\in C(B)}\\text{st}(B^{\\prime}) be the set of players assigned to BB and bags in its subtree. Then, for any bag B∈𝒯B\\in{\\mathcal{T}} and 𝒂B∈𝒜B\\bm{a}\_{B}\\in\\mathcal{A}\_{B}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | h⁡(B,𝒂B)=max⁡∑i∈st​(B)𝒂−B∈𝒜−B⁡ui​(𝒂𝒩⁡(i)).\\displaystyle h(B,\\bm{a}\_{B})=\\max\_{\\bm{a}\_{-B}\\in\\mathcal{A}\_{-B}}\\sum\_{i\\in\\text{st}(B)}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}). |  | (E.2) |\
\
The proof is postponed to the end of this section.\
Note that for the root bag BrB^{r}, since st​(Br)=\[N\]\\text{st}(B^{r})=\[N\], [LemmaE.1](https://arxiv.org/html/2604.28186v1#A5.theoremcounter1 "Lemma E.1. ‣ Appendix E The Optimality of Dynamic Programming on Tree Decomposition ‣ Computing Equilibrium beyond Unilateral Deviation") implies that max𝒂Br∈𝒜Br⁡h⁡(Br,𝒂Br)=max⁡∑i=1N𝒂∈𝒜⁡ui​(𝒂𝒩⁡(i))\\max\_{\\bm{a}\_{B^{r}}\\in\\mathcal{A}\_{B^{r}}}h(B^{r},\\bm{a}\_{B^{r}})=\\max\_{\\bm{a}\\in\\mathcal{A}}\\sum\_{i=1}^{N}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}). Therefore, we find the maximum of ∑i=1Nui​(𝒂𝒩⁡(i))\\sum\_{i=1}^{N}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}), and the optimal joint action 𝒂∈𝒜\\bm{a}\\in\\mathcal{A} can be extracted recursively.\
\
Specifically, let\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | 𝒂Br∗=argmax𝒂Br∈𝒜Brh⁡(Br,𝒂Br)∀B∈C⁡(Br),𝒂B∖Br∗=argmax𝒂B∖Br∈𝒜B∖Brd⁡(B,(𝒂B∖Br,𝒂B∩Br(t+1))).\\begin{split}&\\bm{a}\_{B^{r}}^{\*}=\\mathop{\\mathrm{argmax}}\_{\\bm{a}\_{B^{r}}\\in\\mathcal{A}\_{B^{r}}}h(B^{r},\\bm{a}\_{B^{r}})\\\<br>\\forall B\\in C(B^{r}),~~~&\\bm{a}\_{B\\setminus B^{r}}^{\*}=\\mathop{\\mathrm{argmax}}\_{\\bm{a}\_{B\\setminus B^{r}}\\in\\mathcal{A}\_{B\\setminus B^{r}}}d\\left(B,(\\bm{a}\_{B\\setminus B^{r}},\\bm{a}^{(t+1)}\_{B\\cap B^{r}})\\right).\\end{split} |  | (E.3) |\
\
We will do this recursively until we find the whole 𝒂∗∈𝒜\\bm{a}^{\*}\\in\\mathcal{A}. The tie-breaking rule can be arbitrary, and we use the lexicographic order of joint actions for simplicity. Hence, we prove the optimality of the update rule [E.1](https://arxiv.org/html/2604.28186v1#A5.E1 "In Appendix E The Optimality of Dynamic Programming on Tree Decomposition ‣ Computing Equilibrium beyond Unilateral Deviation"). ∎\
\
See [E.1](https://arxiv.org/html/2604.28186v1#A5.theoremcounter1 "Lemma E.1. ‣ Appendix E The Optimality of Dynamic Programming on Tree Decomposition ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
For leaf bags BB (C⁡(B)=∅C(B)=\\emptyset), for any joint action 𝒂B∈𝒜B\\bm{a}\_{B}\\in\\mathcal{A}\_{B}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | h(B,𝒂B)=∑i∈\[N\]:i​ assigned to ​Bui(𝒂𝒩⁡(i))=\\displaystyle h(B,\\bm{a}\_{B})=\\sum\_{\\begin{subarray}{c}i\\in\[N\]\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})= | ∑i∈st​(B)ui​(𝒂𝒩⁡(i))​=(i)​max⁡∑i∈st​(B)𝒂−B∈𝒜−B⁡ui​(𝒂𝒩⁡(i)).\\displaystyle\\sum\_{i\\in\\text{st}(B)}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})\\overset{(i)}{=}\\max\_{\\bm{a}\_{-B}\\in\\mathcal{A}\_{-B}}\\sum\_{i\\in\\text{st}(B)}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}). |  |\
\
(i)(i) is because 𝒩⁡(i)⊆B\\mathcal{N}(i)\\subseteq B for any ii assigned to BB by definition. Additionally, since BB is a leaf bag, st​(B)={i∈B:i​ assigned to ​B}\\text{st}(B)=\\left\\{i\\in B\\colon i\\text{ assigned to }B\\right\\}.\
\
Then, for any bag BB with all of its children B′∈C⁡(B)B^{\\prime}\\in C(B) satisfying [E.2](https://arxiv.org/html/2604.28186v1#A5.E2 "In Lemma E.1. ‣ Appendix E The Optimality of Dynamic Programming on Tree Decomposition ‣ Computing Equilibrium beyond Unilateral Deviation"), we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | h⁡(B,𝒂B)=\\displaystyle h(B,\\bm{a}\_{B})= | ∑i∈\[N\]:i​ assigned to ​Bui(𝒂𝒩⁡(i))+∑B′∈C⁡(B)max𝒂B′′∈𝒜B′:𝒂B∩B′=𝒂B∩B′′h(B′,𝒂B′′)\\displaystyle\\sum\_{\\begin{subarray}{c}i\\in\[N\]\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})+\\sum\_{B^{\\prime}\\in C(B)}\\max\_{\\begin{subarray}{c}\\bm{a}\_{B^{\\prime}}^{\\prime}\\in\\mathcal{A}\_{B^{\\prime}}\\colon\\\<br>\\bm{a}\_{B\\cap B^{\\prime}}=\\bm{a}\_{B\\cap B^{\\prime}}^{\\prime}\\end{subarray}}h(B^{\\prime},\\bm{a}\_{B^{\\prime}}^{\\prime}) |  |\
|  | =(i)\\displaystyle\\overset{(i)}{=} | ∑i∈\[N\]:i​ assigned to ​Bui(𝒂𝒩⁡(i))+∑B′∈C⁡(B)max𝒂B′′∈𝒜B′:𝒂B∩B′=𝒂B∩B′′max𝒂−B′′∈𝒜−B′∑i∈st​(B′)ui(𝒂𝒩⁡(i)′)\\displaystyle\\sum\_{\\begin{subarray}{c}i\\in\[N\]\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})+\\sum\_{B^{\\prime}\\in C(B)}\\max\_{\\begin{subarray}{c}\\bm{a}\_{B^{\\prime}}^{\\prime}\\in\\mathcal{A}\_{B^{\\prime}}\\colon\\\<br>\\bm{a}\_{B\\cap B^{\\prime}}=\\bm{a}\_{B\\cap B^{\\prime}}^{\\prime}\\end{subarray}}\\max\_{\\bm{a}\_{-B^{\\prime}}^{\\prime}\\in\\mathcal{A}\_{-B^{\\prime}}}\\sum\_{i\\in\\text{st}(B^{\\prime})}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}^{\\prime}) |  |\
|  | =\\displaystyle= | ∑i∈\[N\]:i​ assigned to ​Bui(𝒂𝒩⁡(i))+∑B′∈C⁡(B)max𝒂′∈𝒜:𝒂B∩B′=𝒂B∩B′′∑i∈st​(B′)ui(𝒂𝒩⁡(i)′).\\displaystyle\\sum\_{\\begin{subarray}{c}i\\in\[N\]\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})+\\sum\_{B^{\\prime}\\in C(B)}\\max\_{\\begin{subarray}{c}\\bm{a}^{\\prime}\\in\\mathcal{A}\\colon\\\<br>\\bm{a}\_{B\\cap B^{\\prime}}=\\bm{a}\_{B\\cap B^{\\prime}}^{\\prime}\\end{subarray}}\\sum\_{i\\in\\text{st}(B^{\\prime})}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}^{\\prime}). |  |\
\
(i)(i) uses the induction hypothesis. By [Property 3 of Tree Decomposition](https://arxiv.org/html/2604.28186v1#S7.I1.i3 "In Tree decomposition. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), for any B′∈C⁡(B)B^{\\prime}\\in C(B) and i∈st​(B′)i\\in\\text{st}(B^{\\prime}), 𝒩⁡(i)∩(B∖B′)=∅\\mathcal{N}(i)\\cap\\left(B\\setminus B^{\\prime}\\right)=\\emptyset. Because for any i∈st​(B′)i\\in\\text{st}(B^{\\prime}), there must be a bag B′′B^{\\prime\\prime} in the subtree of B′B^{\\prime} such that 𝒩⁡(i)⊆B′′\\mathcal{N}(i)\\subseteq B^{\\prime\\prime}, and [Property 3 of Tree Decomposition](https://arxiv.org/html/2604.28186v1#S7.I1.i3 "In Tree decomposition. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") will be violated if 𝒩⁡(i)∩B∖B′≠∅\\mathcal{N}(i)\\cap{B\\setminus B^{\\prime}}\\not=\\emptyset. Then, modifying the constraint 𝒂B∩B′=𝒂B∩B′′\\bm{a}\_{B\\cap B^{\\prime}}=\\bm{a}\_{B\\cap B^{\\prime}}^{\\prime} to 𝒂B=𝒂B′\\bm{a}\_{B}=\\bm{a}\_{B}^{\\prime} will not change the value of ui​(𝒂𝒩⁡(i)′)u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}^{\\prime}) for any i∈st​(B′)i\\in\\text{st}(B^{\\prime}). Hence,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | h⁡(B,𝒂B)=\\displaystyle h(B,\\bm{a}\_{B})= | ∑i∈\[N\]:i​ assigned to ​Bui(𝒂𝒩⁡(i))+∑B′∈C⁡(B)max𝒂′∈𝒜:𝒂B=𝒂B′∑i∈st​(B′)ui(𝒂𝒩⁡(i)′).\\displaystyle\\sum\_{\\begin{subarray}{c}i\\in\[N\]\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})+\\sum\_{B^{\\prime}\\in C(B)}\\max\_{\\begin{subarray}{c}\\bm{a}^{\\prime}\\in\\mathcal{A}\\colon\\\<br>\\bm{a}\_{B}=\\bm{a}\_{B}^{\\prime}\\end{subarray}}\\sum\_{i\\in\\text{st}(B^{\\prime})}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}^{\\prime}). |  |\
\
Furthermore, by [Property 3 of Tree Decomposition](https://arxiv.org/html/2604.28186v1#S7.I1.i3 "In Tree decomposition. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), for any B′,B′′∈C⁡(B)B^{\\prime},B^{\\prime\\prime}\\in C(B) and i′∈st​(B′),i′′∈st​(B′′)i^{\\prime}\\in\\text{st}(B^{\\prime}),i^{\\prime\\prime}\\in\\text{st}(B^{\\prime\\prime}), we have 𝒩⁡(i′)∩𝒩⁡(i′′)⊆B\\mathcal{N}(i^{\\prime})\\cap\\mathcal{N}(i^{\\prime\\prime})\\subseteq B. Finally,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | h⁡(B,𝒂B)=\\displaystyle h(B,\\bm{a}\_{B})= | ∑i∈\[N\]:i​ assigned to ​Bui(𝒂𝒩⁡(i))+max𝒂′∈𝒜:𝒂B=𝒂B′∑B′∈C⁡(B)∑i∈st​(B′)ui(𝒂𝒩⁡(i)′)\\displaystyle\\sum\_{\\begin{subarray}{c}i\\in\[N\]\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})+\\max\_{\\begin{subarray}{c}\\bm{a}^{\\prime}\\in\\mathcal{A}\\colon\\\<br>\\bm{a}\_{B}=\\bm{a}\_{B}^{\\prime}\\end{subarray}}\\sum\_{B^{\\prime}\\in C(B)}\\sum\_{i\\in\\text{st}(B^{\\prime})}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}^{\\prime}) |  |\
|  | =\\displaystyle= | max𝒂−B∈𝒜−B(∑i∈\[N\]:i​ assigned to ​Bui(𝒂𝒩⁡(i))+∑B′∈C⁡(B)∑i∈st​(B′)ui(𝒂𝒩⁡(i)′))\\displaystyle\\max\_{\\bm{a}\_{-B}\\in\\mathcal{A}\_{-B}}\\left(\\sum\_{\\begin{subarray}{c}i\\in\[N\]\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)})+\\sum\_{B^{\\prime}\\in C(B)}\\sum\_{i\\in\\text{st}(B^{\\prime})}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}^{\\prime})\\right) |  |\
|  | =\\displaystyle= | max⁡∑i∈st​(B)𝒂−B∈𝒜−B⁡ui​(𝒂𝒩⁡(i)).\\displaystyle\\max\_{\\bm{a}\_{-B}\\in\\mathcal{A}\_{-B}}\\sum\_{i\\in\\text{st}(B)}u\_{i}(\\bm{a}\_{\\mathcal{N}(i)}). |  |\
\
This completes the induction.∎\
\
## Appendix F Proof of [Theorem7.2](https://arxiv.org/html/2604.28186v1\#S7.theoremcounter2 "Theorem 7.2. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
See [7.2](https://arxiv.org/html/2604.28186v1#S7.theoremcounter2 "Theorem 7.2. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
The proof of [Theorem7.2](https://arxiv.org/html/2604.28186v1#S7.theoremcounter2 "Theorem 7.2. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") can be decomposed into three steps.\
\
Firstly, we show that without loss of generality, if FTPL with a fixed noise 𝒏~\\widetilde{\\bm{n}} for all timesteps t=1,2,…t=1,2,\\dots attains sublinear regret when the adversary is oblivious,121212\
\
\
\
\
\
\
\
An oblivious adversary will choose all the utility functions at timestep 00, while an adaptive adversary will choose the utility functions at timestep tt according to π(1),π(2),…,π(t−1)\\pi^{(1)},\\pi^{(2)},\\dots,\\pi^{(t-1)}. then FTPL with independent noise vectors 𝒏~(t)\\widetilde{\\bm{n}}^{(t)} also attains the same regret confronting an adaptive adversary. The reduction to the oblivious setting is common in the literature ( [Agarwal et al., 2019](https://arxiv.org/html/2604.28186v1#bib.bib1 ""); [Suggala and Netrapalli, 2020](https://arxiv.org/html/2604.28186v1#bib.bib42 "")), and we include it here for completeness.\
\
Secondly, we will show that the regret of a fictitious algorithm π(t+1)∈argminπ∈Δ𝒜∑τ=1(t+1)F⁡(π,μ(τ))+⟨𝒏~(t+1),π⟩\\pi^{(t+1)}\\in\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\sum\_{\\tau=1}^{{\\color\[rgb\]{1,0,0}(t+1)}}F\\left(\\pi,\\mu^{(\\tau)}\\right)+\\left\\langle\\widetilde{\\bm{n}}^{(t+1)},\\pi\\right\\rangle is sublinear.\
\
Finally, we will show that the regret of [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") and that of the fictitious algorithm are close.\
\
### F.1 Fixed Noise Vector\
\
In this section, for completeness, we will show a reduction from an adaptive adversary to an oblivious adversary. For ease of representation, we will take correlator (π\\pi) as the _no-regret learner_, and the deviator (μ\\mu) as the _adversary_.\
\
An adaptive adversary determines the utility function at timestep tt, which is μ(t)\\mu^{(t)} in this section, according to our past strategies, π(1),…,π(t−1)\\pi^{(1)},\\dots,\\pi^{(t-1)}. In contrast, an oblivious adversary determines all utility functions, _i.e._, μ(1),…,μ(T)\\mu^{(1)},\\dots,\\mu^{(T)}, at the beginning (timestep 00), such that μ(t)\\mu^{(t)} is irrelevant to π(1),…,π(t−1)\\pi^{(1)},\\dots,\\pi^{(t-1)}. In the following, we will show that a sublinear regret against an oblivious adversary implies a sublinear regret against an adaptive adversary.\
\
Intuitively, when the random noise 𝒏~(1),…,𝒏~(T)\\widetilde{\\bm{n}}^{(1)},\\dots,\\widetilde{\\bm{n}}^{(T)} are independent, π(t)\\pi^{(t)} only depends on μ(1),…,μ(t−1)\\mu^{(1)},\\dots,\\mu^{(t-1)}, which is known to both the oblivious and adaptive adversary, due to the update rule [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). Hence, an additional observation on π(1),…,π(t−1)\\pi^{(1)},\\dots,\\pi^{(t-1)} does not make adversary more powerful. Formally, we have the following lemma ( [Cesa-Bianchi and Lugosi, 2006](https://arxiv.org/html/2604.28186v1#bib.bib11 ""), Lemma 4.1).\
\
###### Lemma F.1(Reformulation of Lemma 4.1 in [Cesa-Bianchi and Lugosi (2006)](https://arxiv.org/html/2604.28186v1\#bib.bib11 "")).\
\
Consider any randomized no-regret learner and the _distribution_ of the decision variable π(t)\\pi^{(t)} is fully determined by μ(1),…,μ(t−1)\\mu^{(1)},\\dots,\\mu^{(t-1)}. Assume the no-regret learner’s regret against any sequence of μ(1),…,μ(T)\\mu^{(1)},\\dots,\\mu^{(T)} generated by an oblivious adversary satisfies that\
\
|     |     |     |\
| --- | --- | --- |\
|  | 𝔼𝒏~(1),…,𝒏~(T)​\[max⁡∑t=1Tπ^∈Δ𝒜⁡F⁡(π(t),μ(t))−F⁡(π^,μ(t))\]⏟Expected Regret≤R.\\displaystyle\\underbrace{\\mathbb{E}\_{\\widetilde{\\bm{n}}^{(1)},\\dots,\\widetilde{\\bm{n}}^{(T)}}\\left\[\\max\_{\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}}\\sum\_{t=1}^{T}F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(t)}\\right)\\right\]}\_{\\text{Expected Regret}}\\leq R. |  |\
\
Then, for any sequence of μ(1),…,μ(T)\\mu^{(1)},\\dots,\\mu^{(T)} generated by an adaptive adversary and δ>0\\delta>0, with probability at least 1−δ1-\\delta, we have\
\
|     |     |     |\
| --- | --- | --- |\
|  | max⁡∑t=1Tπ^∈Δ𝒜⁡F⁡(π(t),μ(t))−F⁡(π^,μ(t))≤R+2​T​log⁡1δ.\\displaystyle\\max\_{\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}}\\sum\_{t=1}^{T}F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(t)}\\right)\\leq R+\\sqrt{2T\\log\\frac{1}{\\delta}}. |  |\
\
It is easy to see that the distribution of π(t)\\pi^{(t)} generated by [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), whose randomness is induced by 𝒏~(t)\\widetilde{\\bm{n}}^{(t)}, is fully determined by μ(1),…,μ(t−1)\\mu^{(1)},\\dots,\\mu^{(t-1)}, given 𝒏~(t)\\widetilde{\\bm{n}}^{(t)} is generated by a fixed distribution independently at each timestep.\
\
Then, we will show that the expected regret of FTPL using independent noise vectors and FTPL with a fixed noise vector is the same, while facing an oblivious adversary.\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | 𝔼𝒏~(1),…,𝒏~(T)​\[∑t=1TF⁡(π(t),μ(t))\]=\\displaystyle\\mathbb{E}\_{\\widetilde{\\bm{n}}^{(1)},\\dots,\\widetilde{\\bm{n}}^{(T)}}\\left\[\\sum\_{t=1}^{T}F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right\]= | ∑t=1T𝔼𝒏~(1),…,𝒏~(T)​\[F⁡(π(t),μ(t))\]\\displaystyle\\sum\_{t=1}^{T}\\mathbb{E}\_{\\widetilde{\\bm{n}}^{(1)},\\dots,\\widetilde{\\bm{n}}^{(T)}}\\left\[F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right\] |  |\
|  | =(i)\\displaystyle\\overset{(i)}{=} | ∑t=1T𝔼𝒏~(t)​\[F⁡(π(t),μ(t))\].\\displaystyle\\sum\_{t=1}^{T}\\mathbb{E}\_{\\widetilde{\\bm{n}}^{(t)}}\\left\[F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right\]. |  |\
\
(i)(i) uses the fact that both π(t)\\pi^{(t)} and μ(t)\\mu^{(t)} are independent of 𝒏~(1),…,𝒏~(t−1)\\widetilde{\\bm{n}}^{(1)},\\dots,\\widetilde{\\bm{n}}^{(t-1)}, when the adversary controlling μ\\mu is oblivious. Finally, the expectation 𝔼𝒏~(1)​\[F⁡(π(t),μ(t))\]\\mathbb{E}\_{\\widetilde{\\bm{n}}^{(1)}}\\left\[F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right\] of\
\
|     |     |     |\
| --- | --- | --- |\
|  | π(t+1)∈argminπ∈Δ𝒜∑τ=1tF⁡(π,μ(τ))−⟨𝒏~(1),π⟩\\displaystyle\\pi^{(t+1)}\\in\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\sum\_{\\tau=1}^{t}F\\left(\\pi,\\mu^{(\\tau)}\\right)-\\left\\langle\\widetilde{\\bm{n}}^{(1)},\\pi\\right\\rangle |  |\
\
is equal to 𝔼𝒏~(t)​\[F⁡(π(t),μ(t))\]\\mathbb{E}\_{\\widetilde{\\bm{n}}^{(t)}}\\left\[F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right\], when 𝒏(t)\\bm{n}^{(t)} and 𝒏(1)\\bm{n}^{(1)} are sampled from an identical distribution.\
In summary,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | fixed noise and an oblivious adversary (Expectation) |  |\
|  | ⇒\\displaystyle\\Rightarrow | independent noise and an oblivious adversary (Expectation) |  |\
|  | ⇒\\displaystyle\\Rightarrow | independent noise and an adaptive adversary (High Probability Bound).\\displaystyle\\text{independent noise and an adaptive adversary (High Probability Bound)}. |  |\
\
Hence, the problem reduces to proving sublinear regret against an oblivious adversary with a fixed noise vector for all timesteps.\
\
### F.2 Low Regret with Accurate Prediction\
\
The discussion above suggests that we only need to show the sublinear regret against an oblivious adversary, when all timesteps share the same noise vector. In other words, we consider the following update rule,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | π(t+1)∈argminπ∈Δ𝒜∑τ=1tF⁡(π,μ(τ))−⟨𝒏~,π⟩,\\displaystyle\\pi^{(t+1)}\\in\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\sum\_{\\tau=1}^{t}F\\left(\\pi,\\mu^{(\\tau)}\\right)-\\left\\langle\\widetilde{\\bm{n}},\\pi\\right\\rangle, |  | (F.1) |\
\
where 𝒏~,𝒏~(1),…,𝒏~(T)\\widetilde{\\bm{n}},\\widetilde{\\bm{n}}^{(1)},\\dots,\\widetilde{\\bm{n}}^{(T)} are identically distributed.\
\
Next, we will show that if the regret minimizer can make the decision π(t+1)\\pi^{(t+1)} with an accurate prediction of μ(t+1)\\mu^{(t+1)}, then we can achieve sublinear regret. In particular, the decision variable at timestep t+1t+1 is chosen according to [F.2](https://arxiv.org/html/2604.28186v1#A6.E2 "In F.2 Low Regret with Accurate Prediction ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | π(t+1)∈argminπ∈Δ𝒜∑τ=1t+1F⁡(π,μ(τ))−⟨𝒏~,π⟩.\\displaystyle\\pi^{(t+1)}\\in\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\sum\_{\\tau=1}^{t{\\color\[rgb\]{1,0,0}+1}}F\\left(\\pi,\\mu^{(\\tau)}\\right)-\\left\\langle\\widetilde{\\bm{n}},\\pi\\right\\rangle. |  | (F.2) |\
\
Actually, we can see that [F.2](https://arxiv.org/html/2604.28186v1#A6.E2 "In F.2 Low Regret with Accurate Prediction ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation") is exactly the original update rule of π(t+2)\\pi^{(t+2)}. Therefore, we will prove the following lemma in the sequel.\
\
###### Lemma F.2.\
\
Consider [F.2](https://arxiv.org/html/2604.28186v1#A6.E2 "In F.2 Low Regret with Accurate Prediction ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation"). For any timestep t=1,2,…t=1,2,\\dots, μ(1),μ(2),…\\mu^{(1)},\\mu^{(2)},\\dots, and any π^∈Δ𝒜\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | ∑τ=1t(F⁡(π(τ+1),μ(τ))−F⁡(π^,μ(τ)))≤⟨𝒏~,π(2)−π^⟩.\\displaystyle\\sum\_{\\tau=1}^{t}\\left(F\\left(\\pi^{(\\tau{\\color\[rgb\]{1,0,0}+1})},\\mu^{(\\tau)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(\\tau)}\\right)\\right)\\leq\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\widehat{\\pi}\\right\\rangle. |  | (F.3) |\
\
###### Proof.\
\
We will prove the lemma by induction. When t=1t=1, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | F⁡(π(2),μ(1))−F⁡(π^,μ(1))\\displaystyle F\\left(\\pi^{(2)},\\mu^{(1)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(1)}\\right) |  |\
|  | =\\displaystyle= | (F⁡(π(2),μ(1))−⟨𝒏~,π(2)⟩)−(F⁡(π^,μ(1))−⟨𝒏~,π^⟩)+⟨𝒏~,π(2)−π^⟩\\displaystyle\\left(F\\left(\\pi^{(2)},\\mu^{(1)}\\right)-\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}\\right\\rangle\\right)-\\left(F\\left(\\widehat{\\pi},\\mu^{(1)}\\right)-\\left\\langle\\widetilde{\\bm{n}},\\widehat{\\pi}\\right\\rangle\\right)+\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\widehat{\\pi}\\right\\rangle |  |\
|  | ≤(i)\\displaystyle\\overset{(i)}{\\leq} | ⟨𝒏~,π(2)−π^⟩.\\displaystyle\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\widehat{\\pi}\\right\\rangle. |  |\
\
(i)(i) is because π(2)∈argminπ∈Δ𝒜F⁡(π,μ(1))−⟨𝒏~,π⟩\\pi^{(2)}\\in\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}F\\left(\\pi,\\mu^{(1)}\\right)-\\left\\langle\\widetilde{\\bm{n}},\\pi\\right\\rangle.\
\
Next, we will show that when [F.3](https://arxiv.org/html/2604.28186v1#A6.E3 "In Lemma F.2. ‣ F.2 Low Regret with Accurate Prediction ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation") holds for t=t0t=t\_{0}, then it also holds for t=t0+1t=t\_{0}+1. For any π^∈Δ𝒜\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | ∑τ=1t0+1(F⁡(π(τ+1),μ(τ))−F⁡(π^,μ(τ)))\\displaystyle\\sum\_{\\tau=1}^{t\_{0}+1}\\left(F\\left(\\pi^{(\\tau+1)},\\mu^{(\\tau)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(\\tau)}\\right)\\right) |  |\
|  | =\\displaystyle= | ∑τ=1t0+1F⁡(π(τ+1),μ(τ))−(∑τ=1t0+1F⁡(π^,μ(τ))−⟨𝒏~,π^⟩)−⟨𝒏~,π^⟩\\displaystyle\\sum\_{\\tau=1}^{t\_{0}+1}F\\left(\\pi^{(\\tau+1)},\\mu^{(\\tau)}\\right)-\\left(\\sum\_{\\tau=1}^{t\_{0}+1}F\\left(\\widehat{\\pi},\\mu^{(\\tau)}\\right)-\\left\\langle\\widetilde{\\bm{n}},\\widehat{\\pi}\\right\\rangle\\right)-\\left\\langle\\widetilde{\\bm{n}},\\widehat{\\pi}\\right\\rangle |  |\
|  | ≤(i)\\displaystyle\\overset{(i)}{\\leq} | ∑τ=1t0+1F⁡(π(τ+1),μ(τ))−(∑τ=1t0+1F⁡(π(t0+2),μ(τ))−⟨𝒏~,π(t0+2)⟩)−⟨𝒏~,π^⟩\\displaystyle\\sum\_{\\tau=1}^{t\_{0}+1}F\\left(\\pi^{(\\tau+1)},\\mu^{(\\tau)}\\right)-\\left(\\sum\_{\\tau=1}^{t\_{0}+1}F\\left(\\pi^{(t\_{0}+2)},\\mu^{(\\tau)}\\right)-\\left\\langle\\widetilde{\\bm{n}},\\pi^{(t\_{0}+2)}\\right\\rangle\\right)-\\left\\langle\\widetilde{\\bm{n}},\\widehat{\\pi}\\right\\rangle |  |\
|  | =\\displaystyle= | ∑τ=1t0(F⁡(π(τ+1),μ(τ))−F⁡(π(t0+2),μ(τ)))+⟨𝒏~,π(t0+2)−π^⟩.\\displaystyle\\sum\_{\\tau=1}^{t\_{0}}\\left(F\\left(\\pi^{(\\tau+1)},\\mu^{(\\tau)}\\right)-F\\left(\\pi^{(t\_{0}+2)},\\mu^{(\\tau)}\\right)\\right)+\\left\\langle\\widetilde{\\bm{n}},\\pi^{(t\_{0}+2)}-\\widehat{\\pi}\\right\\rangle. |  |\
\
(i)(i) is because π(t0+2)∈argminπ∈Δ𝒜∑τ=1t0+1F⁡(π,μ(τ))−⟨𝒏~,π⟩\\pi^{(t\_{0}+2)}\\in\\mathop{\\mathrm{argmin}}\_{\\pi\\in\\Delta^{\\mathcal{A}}}\\sum\_{\\tau=1}^{t\_{0}+1}F\\left(\\pi,\\mu^{(\\tau)}\\right)-\\left\\langle\\widetilde{\\bm{n}},\\pi\\right\\rangle. Next, by setting π^=π(t0+2)\\widehat{\\pi}=\\pi^{(t\_{0}+2)} in the induction hypothesis, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | ∑τ=1t0(F⁡(π(τ+1),μ(τ))−F⁡(π(t0+2),μ(τ)))+⟨𝒏~,π(t0+2)−π^⟩\\displaystyle\\sum\_{\\tau=1}^{t\_{0}}\\left(F\\left(\\pi^{(\\tau+1)},\\mu^{(\\tau)}\\right)-F\\left(\\pi^{(t\_{0}+2)},\\mu^{(\\tau)}\\right)\\right)+\\left\\langle\\widetilde{\\bm{n}},\\pi^{(t\_{0}+2)}-\\widehat{\\pi}\\right\\rangle |  |\
|  | ≤\\displaystyle\\leq | ⟨𝒏~,π(2)−π(t0+2)⟩+⟨𝒏~,π(t0+2)−π^⟩\\displaystyle\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\pi^{(t\_{0}+2)}\\right\\rangle+\\left\\langle\\widetilde{\\bm{n}},\\pi^{(t\_{0}+2)}-\\widehat{\\pi}\\right\\rangle |  |\
|  | =\\displaystyle= | ⟨𝒏~,π(2)−π^⟩.∎\\displaystyle\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\widehat{\\pi}\\right\\rangle.\\qed |  |\
\
### F.3 Sublinear Variation\
\
In this section, we will show that the regret of FTPL with/without a prediction of μ(t+1)\\mu^{(t+1)} is close. Formally, for any π^∈Δ𝒜\\widehat{\\pi}\\in\\Delta^{\\mathcal{A}}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | ∑t=1T(F⁡(π(t),μ(t))−F⁡(π^,μ(t)))\\displaystyle\\sum\_{t=1}^{T}\\left(F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(t)}\\right)\\right) |  |\
|  | =\\displaystyle= | ∑t=1T(F⁡(π(t+1),μ(t))−F⁡(π^,μ(t)))+∑t=1T(F⁡(π(t),μ(t))−F⁡(π(t+1),μ(t)))\\displaystyle\\sum\_{t=1}^{T}\\left(F\\left(\\pi^{(t+1)},\\mu^{(t)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(t)}\\right)\\right)+\\sum\_{t=1}^{T}\\left(F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\pi^{(t+1)},\\mu^{(t)}\\right)\\right) |  |\
|  | ≤(i)\\displaystyle\\overset{(i)}{\\leq} | ⟨𝒏~,π(2)−π^⟩+∑t=1T(F⁡(π(t),μ(t))−F⁡(π(t+1),μ(t))).\\displaystyle\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\widehat{\\pi}\\right\\rangle+\\sum\_{t=1}^{T}\\left(F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\pi^{(t+1)},\\mu^{(t)}\\right)\\right). |  |\
\
(i)(i) uses [LemmaF.2](https://arxiv.org/html/2604.28186v1#A6.theoremcounter2 "Lemma F.2. ‣ F.2 Low Regret with Accurate Prediction ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
Moreover, since 𝒰i​(𝒂)∈\[0,1\]\\mathcal{U}\_{i}(\\bm{a})\\in\[0,1\] for any i∈\[N\]i\\in\[N\] and 𝒂∈𝒜\\bm{a}\\in\\mathcal{A}, we have\
\
|     |     |     |\
| --- | --- | --- |\
|  | maxπ∈Δ𝒜,μ∈Δ×S∈𝒮𝒜S⁡\|F⁡(π,μ)\|≤1.\\displaystyle\\max\_{\\begin{subarray}{c}\\pi\\in\\Delta^{\\mathcal{A}},\\\<br>\\mu\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}\\end{subarray}}\\left\|F\\left(\\pi,\\mu\\right)\\right\|\\leq 1. |  |\
\
Then,\
\
|     |     |     |\
| --- | --- | --- |\
|  | 𝔼⁡\[F⁡(π(t),μ(t))−F⁡(π(t+1),μ(t))\]≤Pr𝒏~⁡(π(t)≠π(t+1)).\\displaystyle\\mathbb{E}\\left\[F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\pi^{(t+1)},\\mu^{(t)}\\right)\\right\]\\leq\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\pi^{(t)}\\not=\\pi^{(t+1)}\\right). |  |\
\
Hence, we only need to lower bound Pr𝒏~⁡(π(t)=π(t+1))\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\pi^{(t)}=\\pi^{(t+1)}\\right) in the sequel. Recall that π(t)\\pi^{(t)} is a pure strategy with π(t)​(𝒂(t))=1\\pi^{(t)}\\left(\\bm{a}^{(t)}\\right)=1 for some joint action 𝒂(t)∈𝒜\\bm{a}^{(t)}\\in\\mathcal{A}. For any bag B∈𝒯B\\in{\\mathcal{T}}, let f​a​(B)fa(B) denote its father (f​a​(B)=∅fa(B)=\\emptyset if BB is the root). Then,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | Pr𝒏~⁡(π(t)=π(t+1))=\\displaystyle\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\pi^{(t)}=\\pi^{(t+1)}\\right)= | Pr𝒏~⁡(𝒂(t)=𝒂(t+1))\\displaystyle\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\bm{a}^{(t)}=\\bm{a}^{(t+1)}\\right) |  |\
|  | =(i)\\displaystyle\\overset{(i)}{=} | ∏B∈𝒯Pr𝒏~⁡(𝒂B∖f​a​(B)(t)=𝒂B∖f​a​(B)(t+1)\|𝒂f​a​(B)(t)=𝒂f​a​(B)(t+1)).\\displaystyle\\prod\_{B\\in{\\mathcal{T}}}\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\bm{a}\_{B\\setminus fa(B)}^{(t)}=\\bm{a}\_{B\\setminus fa(B)}^{(t+1)}{\\,\\big\|\\,}\\bm{a}\_{fa(B)}^{(t)}=\\bm{a}\_{fa(B)}^{(t+1)}\\right). |  |\
\
According to [7.6](https://arxiv.org/html/2604.28186v1#S7.E6 "In Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), each bag B∈𝒯B\\in{\\mathcal{T}} only determines 𝒂B∖f​a​(B)(t)\\bm{a}\_{B\\setminus fa(B)}^{(t)}. Since 𝒏(t)​(B,⋅)\\bm{n}^{(t)}(B,\\cdot) is sampled independently for every bag BB, it follows that 𝒂B′∖B(t),𝒂B′′∖B(t)\\bm{a}\_{B^{\\prime}\\setminus B}^{(t)},\\bm{a}\_{B^{\\prime\\prime}\\setminus B}^{(t)} are independent for B′,B′′∈C⁡(B)B^{\\prime},B^{\\prime\\prime}\\in C(B) with B′≠B′′B^{\\prime}\\not=B^{\\prime\\prime}, by [Property 3 of Tree Decomposition](https://arxiv.org/html/2604.28186v1#S7.I1.i3 "In Tree decomposition. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). Hence, (i)(i) holds.\
\
For any B∈𝒯B\\in{\\mathcal{T}}, to lower bound Pr𝒏~⁡(𝒂B∖f​a​(B)(t)=𝒂B∖f​a​(B)(t+1)\|𝒂f​a​(B)(t)=𝒂f​a​(B)(t+1))\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\bm{a}\_{B\\setminus fa(B)}^{(t)}=\\bm{a}\_{B\\setminus fa(B)}^{(t+1)}{\\,\\big\|\\,}\\bm{a}\_{fa(B)}^{(t)}=\\bm{a}\_{fa(B)}^{(t+1)}\\right), we will first get its lower bound while further conditioning on 𝒂B∪f​a​(B)(t)\\bm{a}^{(t)}\_{B\\cup fa(B)}’s value and 𝒏⁡(B,⋅)\\bm{n}(B,\\cdot)’s value.\
\
Then, Pr𝒏~⁡(𝒂B∖f​a​(B)(t)=𝒂B∖f​a​(B)(t+1)\|𝒂f​a​(B)(t)=𝒂f​a​(B)(t+1))\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\bm{a}\_{B\\setminus fa(B)}^{(t)}=\\bm{a}\_{B\\setminus fa(B)}^{(t+1)}{\\,\\big\|\\,}\\bm{a}\_{fa(B)}^{(t)}=\\bm{a}\_{fa(B)}^{(t+1)}\\right) is equal to this conditioned probability integrating over all possible values of 𝒂B∪f​a​(B)(t)\\bm{a}^{(t)}\_{B\\cup fa(B)} and 𝒏⁡(B,⋅)\\bm{n}(B,\\cdot). Formally, we want to lower bound\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | pB(t)​(𝒂B∪f​a​(B)′,𝒙)≔Pr⁡(CLOSE\\displaystyle p\_{B}^{(t)}(\\bm{a}\_{B\\cup fa(B)}^{\\prime},\\bm{x})\\coloneqq\\Pr\\Big( | 𝒂B∖f​a​(B)(t+1)=𝒂B∖f​a​(B)′\|𝒂f​a​(B)(t)=𝒂f​a​(B)(t+1),𝒂B∪f​a​(B)(t)=𝒂B∪f​a​(B)′,\\displaystyle\\bm{a}\_{B\\setminus fa(B)}^{(t+1)}=\\bm{a}\_{B\\setminus fa(B)}^{\\prime}{\\,\\Big\|\\,}\\bm{a}\_{fa(B)}^{(t)}=\\bm{a}\_{fa(B)}^{(t+1)}~,~\\bm{a}\_{B\\cup fa(B)}^{(t)}=\\bm{a}\_{B\\cup fa(B)}^{\\prime}~,~ |  |\
|  |  | and ​∀𝒂B∖f​a​(B)∈𝒜B∖f​a​(B)∖{𝒂B∖f​a​(B)′},\\displaystyle\\text{ and }\\forall\\bm{a}\_{B\\setminus fa(B)}\\in\\mathcal{A}\_{B\\setminus fa(B)}\\setminus\\left\\{\\bm{a}\_{B\\setminus fa(B)}^{\\prime}\\right\\}, |  |\
|  |  | OPENn⁡(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B)))=x⁡((𝒂B∩f​a​(B)′,𝒂B∖f​a​(B))))\\displaystyle n(B,(\\bm{a}^{\\prime}\_{B\\cap fa(B)},\\bm{a}\_{B\\setminus fa(B)}))=x((\\bm{a}^{\\prime}\_{B\\cap fa(B)},\\bm{a}\_{B\\setminus fa(B)}))\\Big) |  |\
\
for any 𝒂B∪f​a​(B)′∈𝒜B∪f​a​(B)\\bm{a}\_{B\\cup fa(B)}^{\\prime}\\in\\mathcal{A}\_{B\\cup fa(B)} and 𝒙∈ℝ𝒜B\\bm{x}\\in\\mathbb{R}^{\\mathcal{A}\_{B}}. Then,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | Pr𝒏~⁡(𝒂B∖f​a​(B)(t)=𝒂B∖f​a​(B)(t+1)\|𝒂f​a​(B)(t)=𝒂f​a​(B)(t+1))≥inf𝒂B∪f​a​(B)′∈𝒜B∪f​a​(B),𝒙∈ℝ𝒜BpB(t)​(𝒂B∪f​a​(B)′,𝒙),\\displaystyle\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\bm{a}\_{B\\setminus fa(B)}^{(t)}=\\bm{a}\_{B\\setminus fa(B)}^{(t+1)}{\\,\\big\|\\,}\\bm{a}\_{fa(B)}^{(t)}=\\bm{a}\_{fa(B)}^{(t+1)}\\right)\\geq\\inf\_{\\begin{subarray}{c}\\bm{a}\_{B\\cup fa(B)}^{\\prime}\\in\\mathcal{A}\_{B\\cup fa(B)},\\\<br>\\bm{x}\\in\\mathbb{R}^{\\mathcal{A}\_{B}}\\end{subarray}}p\_{B}^{(t)}(\\bm{a}\_{B\\cup fa(B)}^{\\prime},\\bm{x}), |  |\
\
since Pr𝒏~⁡(𝒂B∖f​a​(B)(t)=𝒂B∖f​a​(B)(t+1)\|𝒂f​a​(B)(t)=𝒂f​a​(B)(t+1))\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\bm{a}\_{B\\setminus fa(B)}^{(t)}=\\bm{a}\_{B\\setminus fa(B)}^{(t+1)}{\\,\\big\|\\,}\\bm{a}\_{fa(B)}^{(t)}=\\bm{a}\_{fa(B)}^{(t+1)}\\right) is equal to pB(t)​(𝒂B∪f​a​(B)′,𝒙)p\_{B}^{(t)}(\\bm{a}\_{B\\cup fa(B)}^{\\prime},\\bm{x}) integrating over 𝒂B∪f​a​(B)′\\bm{a}\_{B\\cup fa(B)}^{\\prime} and 𝒙\\bm{x}.\
\
Since 𝒂B∖f​a​(B)(t)=𝒂B∖f​a​(B)′\\bm{a}\_{B\\setminus fa(B)}^{(t)}=\\bm{a}\_{B\\setminus fa(B)}^{\\prime}, for any 𝒂B∖f​a​(B)∈𝒜B∖f​a​(B)∖{𝒂B∖f​a​(B)′}\\bm{a}\_{B\\setminus fa(B)}\\in\\mathcal{A}\_{B\\setminus fa(B)}\\setminus\\left\\{\\bm{a}\_{B\\setminus fa(B)}^{\\prime}\\right\\}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | d(t)​(B,𝒂B′)≤d(t)​(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B))).\\displaystyle d^{(t)}\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\leq d^{(t)}\\left(B,(\\bm{a}\_{B\\cap fa(B)}^{\\prime},\\bm{a}\_{B\\setminus fa(B)})\\right). |  |\
\
This can be equivalently written as\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | n⁡(B,𝒂B′)≥\\displaystyle n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\geq | (d(t)​(B,𝒂B′)+n⁡(B,𝒂B′))−d(t)​(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B))).\\displaystyle\\left(d^{(t)}\\left(B,\\bm{a}\_{B}^{\\prime}\\right)+n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\right)-d^{(t)}\\left(B,(\\bm{a}\_{B\\cap fa(B)}^{\\prime},\\bm{a}\_{B\\setminus fa(B)})\\right). |  |\
\
Then, 𝒂B∖f​a​(B)(t+1)=𝒂B∖f​a​(B)′\\bm{a}\_{B\\setminus fa(B)}^{(t+1)}=\\bm{a}\_{B\\setminus fa(B)}^{\\prime} is equivalent to\
\
|     |     |     |     |     |\
| --- | --- | --- | --- | --- |\
|  | n⁡(B,𝒂B′)≥\\displaystyle n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\geq | (d(t+1)​(B,𝒂B′)+n⁡(B,𝒂B′))−d(t+1)​(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B)))\\displaystyle\\left(d^{(t+1)}\\left(B,\\bm{a}\_{B}^{\\prime}\\right)+n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\right)-d^{(t+1)}\\left(B,(\\bm{a}\_{B\\cap fa(B)}^{\\prime},\\bm{a}\_{B\\setminus fa(B)})\\right) |  | (F.4) |\
|  | =\\displaystyle= | (d(t)​(B,𝒂B′)+n⁡(B,𝒂B′))−d(t)​(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B)))\\displaystyle\\left(d^{(t)}\\left(B,\\bm{a}\_{B}^{\\prime}\\right)+n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\right)-d^{(t)}\\left(B,(\\bm{a}\_{B\\cap fa(B)}^{\\prime},\\bm{a}\_{B\\setminus fa(B)})\\right) |  |\
|  |  | +(d(t)​(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B)))−d(t+1)​(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B))))\\displaystyle+\\left(d^{(t)}\\left(B,(\\bm{a}\_{B\\cap fa(B)}^{\\prime},\\bm{a}\_{B\\setminus fa(B)})\\right)-d^{(t+1)}\\left(B,(\\bm{a}\_{B\\cap fa(B)}^{\\prime},\\bm{a}\_{B\\setminus fa(B)})\\right)\\right) |  |\
|  |  | +(d(t+1)​(B,𝒂B′)−d(t)​(B,𝒂B′)).\\displaystyle+\\left(d^{(t+1)}\\left(B,\\bm{a}\_{B}^{\\prime}\\right)-d^{(t)}\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\right). |  |\
\
for any 𝒂B∖f​a​(B)∈𝒜B∖f​a​(B)\\bm{a}\_{B\\setminus fa(B)}\\in\\mathcal{A}\_{B\\setminus fa(B)}. In [LemmaF.3](https://arxiv.org/html/2604.28186v1#A6.theoremcounter3 "Lemma F.3. ‣ F.3 Sublinear Variation ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation"), we show that the variation of 𝒅\\bm{d} is bounded by 11. Therefore,\
\
|     |     |     |\
| --- | --- | --- |\
|  | n⁡(B,𝒂B′)≥(d(t)​(B,𝒂B′)+n⁡(B,𝒂B′))−d(t)​(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B)))+2\\displaystyle n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\geq\\left(d^{(t)}\\left(B,\\bm{a}\_{B}^{\\prime}\\right)+n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\right)-d^{(t)}\\left(B,(\\bm{a}\_{B\\cap fa(B)}^{\\prime},\\bm{a}\_{B\\setminus fa(B)})\\right)+2 |  |\
\
implies [F.4](https://arxiv.org/html/2604.28186v1#A6.E4 "In F.3 Sublinear Variation ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
###### Lemma F.3.\
\
Consider the update rule [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). For any timestep t=1,2,…,Tt=1,2,\\dots,T, bag B∈𝒯B\\in{\\mathcal{T}}, joint action 𝒂B∈𝒜B\\bm{a}\_{B}\\in\\mathcal{A}\_{B}, and noise 𝒏~∈ℝ×B∈𝒯𝒜B\\widetilde{\\bm{n}}\\in\\mathbb{R}^{\\bigtimes\_{B\\in{\\mathcal{T}}}\\mathcal{A}\_{B}}, we have\
\
|     |     |     |\
| --- | --- | --- |\
|  | \|d(t+1)​(B,𝒂B)−d(t)​(B,𝒂B)\|≤1.\\displaystyle\\left\|d^{(t+1)}(B,\\bm{a}\_{B})-d^{(t)}(B,\\bm{a}\_{B})\\right\|\\leq 1. |  |\
\
The proof is postponed to the end of this section. Let\
\
|     |     |     |\
| --- | --- | --- |\
|  | w=max𝒂B∖f​a​(B)∈𝒜B∖f​a​(B)∖{𝒂B∖f​a​(B)′}⁡(d(t)​(B,𝒂B′)+n⁡(B,𝒂B′))−d(t)​(B,(𝒂B∩f​a​(B)′,𝒂B∖f​a​(B))).\\displaystyle w=\\max\_{\\bm{a}\_{B\\setminus fa(B)}\\in\\mathcal{A}\_{B\\setminus fa(B)}\\setminus\\left\\{\\bm{a}\_{B\\setminus fa(B)}^{\\prime}\\right\\}}\\allowbreak\\left(d^{(t)}\\left(B,\\bm{a}\_{B}^{\\prime}\\right)+n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\right)-d^{(t)}\\left(B,(\\bm{a}\_{B\\cap fa(B)}^{\\prime},\\bm{a}\_{B\\setminus fa(B)})\\right). |  |\
\
Note that ww only depends on μ(1),…,μ(t−1)\\mu^{(1)},\\dots,\\mu^{(t-1)} and 𝒙\\bm{x}. Then,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | pB(t)​(𝒂B∪f​a​(B)′,𝒙)≥\\displaystyle p\_{B}^{(t)}(\\bm{a}\_{B\\cup fa(B)}^{\\prime},\\bm{x})\\geq | Pr⁡(n⁡(B,𝒂B′)≥w+2\|n⁡(B,𝒂B′)≥w)\\displaystyle\\Pr\\left(n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\geq w+2{\\,\|\\,}n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\geq w\\right) |  |\
|  | =\\displaystyle= | Pr⁡(n⁡(B,𝒂B′)≥w+2)Pr⁡(n⁡(B,𝒂B′)≥w)\\displaystyle\\frac{\\Pr\\left(n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\geq w+2\\right)}{\\Pr\\left(n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\geq w\\right)} |  |\
|  | =(i)\\displaystyle\\overset{(i)}{=} | exp⁡(−η⁡(w+2))exp⁡(−η​w)\\displaystyle\\frac{\\exp\\left(-\\eta\\left(w+2\\right)\\right)}{\\exp\\left(-\\eta w\\right)} |  |\
|  | =\\displaystyle= | exp⁡(−2​η).\\displaystyle\\exp\\left(-2\\eta\\right). |  |\
\
(i)(i) is because n⁡(B,𝒂B′)∼Exp⁡(η)n\\left(B,\\bm{a}\_{B}^{\\prime}\\right)\\sim{\\rm Exp}(\\eta). Finally, by union bound,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | Pr𝒏~⁡(π(t)=π(t+1))≥\\displaystyle\\Pr\_{\\widetilde{\\bm{n}}}\\left(\\pi^{(t)}=\\pi^{(t+1)}\\right)\\geq | 1−∑B∈𝒯(1−pB(t)​(𝒂B∪f​a​(B)′,𝒙))\\displaystyle 1-\\sum\_{B\\in{\\mathcal{T}}}\\left(1-p\_{B}^{(t)}(\\bm{a}\_{B\\cup fa(B)}^{\\prime},\\bm{x})\\right) |  |\
|  | ≥\\displaystyle\\geq | 1−∑B∈𝒯(1−exp⁡(−2​η))\\displaystyle 1-\\sum\_{B\\in{\\mathcal{T}}}\\left(1-\\exp\\left(-2\\eta\\right)\\right) |  |\
|  | ≥\\displaystyle\\geq | 1−∑B∈𝒯2​η\\displaystyle 1-\\sum\_{B\\in{\\mathcal{T}}}2\\eta |  |\
|  | =\\displaystyle= | 1−2​η​\|𝒯\|.\\displaystyle 1-2\\eta\\left\|{\\mathcal{T}}\\right\|. |  |\
\
Therefore,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | 𝔼⁡\[∑t=1TF⁡(π(t),μ(t))−F⁡(π^,μ(t))\]\\displaystyle\\mathbb{E}\\left\[\\sum\_{t=1}^{T}F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(t)}\\right)\\right\] |  |\
|  | ≤\\displaystyle\\leq | 𝔼⁡\[⟨𝒏~,π(2)−π^⟩\]+∑t=1T𝔼⁡\[F⁡(π(t),μ(t))−F⁡(π(t+1),μ(t))\]\\displaystyle\\mathbb{E}\\left\[\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\widehat{\\pi}\\right\\rangle\\right\]+\\sum\_{t=1}^{T}\\mathbb{E}\\left\[F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\pi^{(t+1)},\\mu^{(t)}\\right)\\right\] |  |\
|  | ≤\\displaystyle\\leq | 𝔼⁡\[⟨𝒏~,π(2)−π^⟩\]+2​η​\|𝒯\|​T.\\displaystyle\\mathbb{E}\\left\[\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\widehat{\\pi}\\right\\rangle\\right\]+2\\eta\\left\|{\\mathcal{T}}\\right\|T. |  |\
\
Since exp⁡(x)≥1+x\\exp(x)\\geq 1+x for any x∈ℝx\\in\\mathbb{R}, (1−exp⁡(−2​η​\|𝒯\|))≤2​η​\|𝒯\|\\left(1-\\exp\\left(-2\\eta\\left\|{\\mathcal{T}}\\right\|\\right)\\right)\\leq 2\\eta\\left\|{\\mathcal{T}}\\right\|. Additionally,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | 𝔼⁡\[⟨𝒏~,π(2)−π^⟩\]​≤(i)​𝔼​\[‖𝒏~‖∞⋅‖π(2)−π^‖1\]≤\\displaystyle\\mathbb{E}\\left\[\\left\\langle\\widetilde{\\bm{n}},\\pi^{(2)}-\\widehat{\\pi}\\right\\rangle\\right\]\\overset{(i)}{\\leq}\\mathbb{E}\\left\[\\left\\\|\\widetilde{\\bm{n}}\\right\\\|\_{\\infty}\\cdot\\left\\\|\\pi^{(2)}-\\widehat{\\pi}\\right\\\|\_{1}\\right\]\\leq | 2​𝔼​\[‖𝒏~‖∞\]\\displaystyle 2\\mathbb{E}\\left\[\\left\\\|\\widetilde{\\bm{n}}\\right\\\|\_{\\infty}\\right\] |  |\
|  | ≤\\displaystyle\\leq | 2​∑B∈𝒯max𝒂B∈𝒜B⁡n⁡(B,𝒂B)\\displaystyle 2\\sum\_{B\\in{\\mathcal{T}}}\\max\_{\\bm{a}\_{B}\\in\\mathcal{A}\_{B}}n(B,\\bm{a}\_{B}) |  |\
|  | ≤(i)\\displaystyle\\overset{(i)}{\\leq} | 2​∑B∈𝒯1+log⁡\|𝒜B\|η.\\displaystyle 2\\sum\_{B\\in{\\mathcal{T}}}\\frac{1+\\log\\left\|\\mathcal{A}\_{B}\\right\|}{\\eta}. |  |\
\
(i)(i) is by Hölder’s Inequality. (i​i)(ii) is because the expectation of the maximum of nn i.i.d. random variable sampled from Exp⁡(η){\\rm Exp}(\\eta) is upper bounded by 1+log⁡nη\\frac{1+\\log n}{\\eta}( [Agarwal et al., 2019](https://arxiv.org/html/2604.28186v1#bib.bib1 "")). Furthermore, log⁡\|𝒜B\|≤\|B\|⋅log⁡A≤(tw⁡(𝒢)+1)​log⁡A\\log\\left\|\\mathcal{A}\_{B}\\right\|\\leq\|B\|\\cdot\\log A\\leq\\left({\\rm tw}(\\mathcal{G})+1\\right)\\log A. Hence,\
\
|     |     |     |\
| --- | --- | --- |\
|  | 𝔼⁡\[∑t=1TF⁡(π(t),μ(t))−F⁡(π^,μ(t))\]≤2​\|𝒯\|​1+(tw⁡(𝒢)+1)​log⁡Aη+2​η​\|𝒯\|​T.\\displaystyle\\mathbb{E}\\left\[\\sum\_{t=1}^{T}F\\left(\\pi^{(t)},\\mu^{(t)}\\right)-F\\left(\\widehat{\\pi},\\mu^{(t)}\\right)\\right\]\\leq 2\\left\|{\\mathcal{T}}\\right\|\\frac{1+\\left({\\rm tw}(\\mathcal{G})+1\\right)\\log A}{\\eta}+2\\eta\\left\|{\\mathcal{T}}\\right\|T. |  |\
\
∎\
\
### F.4 Proof of Auxiliary Lemmas\
\
See [F.3](https://arxiv.org/html/2604.28186v1#A6.theoremcounter3 "Lemma F.3. ‣ F.3 Sublinear Variation ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
Recall [LemmaE.1](https://arxiv.org/html/2604.28186v1#A5.theoremcounter1 "Lemma E.1. ‣ Appendix E The Optimality of Dynamic Programming on Tree Decomposition ‣ Computing Equilibrium beyond Unilateral Deviation"). We can add \|𝒯\|\|{\\mathcal{T}}\| players as the noise player, each assigned to a bag in 𝒯{\\mathcal{T}}, with ui​(𝒂B)=n⁡(B,𝒂B)u\_{i}(\\bm{a}\_{B})=n(B,\\bm{a}\_{B}) so that 𝒩⁡(i)=B\\mathcal{N}(i)=B. Recall that uiu\_{i} is the contribution of player ii to the objective function FF. Then, by [LemmaE.1](https://arxiv.org/html/2604.28186v1#A5.theoremcounter1 "Lemma E.1. ‣ Appendix E The Optimality of Dynamic Programming on Tree Decomposition ‣ Computing Equilibrium beyond Unilateral Deviation"), for any B∈𝒯B\\in{\\mathcal{T}} and 𝒂B∈𝒜B\\bm{a}\_{B}\\in\\mathcal{A}\_{B}, we have\
\
|     |     |     |\
| --- | --- | --- |\
|  | d(t)​(B,𝒂B)=min⁡∑i∈st​(B)𝒂−B∈𝒜−B⁡ui(t)​(𝒂𝒩⁡(i)),\\displaystyle d^{(t)}(B,\\bm{a}\_{B})=\\min\_{\\bm{a}\_{-B}\\in\\mathcal{A}\_{-B}}\\sum\_{i\\in\\text{st}(B)}u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)}), |  |\
\
where\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | ui(t)(𝒂𝒩⁡(i))=−∑τ=1t∑S∈𝒮:i∈S1\|S\|∑𝒂^𝒩iS∈𝒜𝒩iSμ(τ)(S,𝒂^𝒩iS)(𝒰i(𝒂^𝒩iS,𝒂𝒩⁡(i)∖S)−𝒰i(𝒂𝒩⁡(i))) for i∈\[N\]\\displaystyle u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)})=-\\sum\_{\\tau=1}^{t}\\sum\_{\\begin{subarray}{c}S\\in{\\mathcal{S}}\\colon\\\<br>i\\in S\\end{subarray}}~\\frac{1}{\|S\|}\\sum\_{\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\in\\mathcal{A}\_{\\mathcal{N}\_{i}^{S}}}\\mu^{(\\tau)}\\left(S,\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\right)\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}},\\bm{a}\_{\\mathcal{N}(i)\\setminus S}\\right)-\\mathcal{U}\_{i}(\\bm{a}\_{\\mathcal{N}(i)})\\right)\\text{ for }i\\in\[N\] |  |\
|  |  | ui(t)​(𝒂𝒩⁡(i))=n⁡(B,𝒂𝒩⁡(i))​ for i as the noise player assigned to bag ​B.\\displaystyle u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)})=n(B,\\bm{a}\_{\\mathcal{N}(i)})\\text{ for $i$ as the noise player assigned to bag }B. |  |\
\
For any noise player, we can see that ui(t)​(𝒂𝒩⁡(i))−ui(t+1)​(𝒂𝒩⁡(i))=0u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)})-u\_{i}^{(t+1)}(\\bm{a}\_{\\mathcal{N}(i)})=0. For any i∈\[N\]i\\in\[N\],\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | \|ui(t)​(𝒂𝒩⁡(i))−ui(t+1)​(𝒂𝒩⁡(i))\|\\displaystyle\\left\|u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)})-u\_{i}^{(t+1)}(\\bm{a}\_{\\mathcal{N}(i)})\\right\| |  |\
|  | =\\displaystyle= | \|∑S∈𝒮:i∈S1\|S\|∑𝒂^𝒩iS∈𝒜𝒩iSμ(t+1)(S,𝒂^𝒩iS)(𝒰i(𝒂^𝒩iS,𝒂𝒩⁡(i)∖S)−𝒰i(𝒂𝒩⁡(i)))\|\\displaystyle\\left\|\\sum\_{\\begin{subarray}{c}S\\in{\\mathcal{S}}\\colon\\\<br>i\\in S\\end{subarray}}~\\frac{1}{\|S\|}\\sum\_{\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\in\\mathcal{A}\_{\\mathcal{N}\_{i}^{S}}}\\mu^{(t+1)}\\left(S,\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\right)\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}},\\bm{a}\_{\\mathcal{N}(i)\\setminus S}\\right)-\\mathcal{U}\_{i}(\\bm{a}\_{\\mathcal{N}(i)})\\right)\\right\| |  |\
|  | ≤\\displaystyle\\leq | ∑S∈𝒮:i∈S1\|S\|∑𝒂^𝒩iS∈𝒜𝒩iSμ(t+1)(S,𝒂^𝒩iS)\|𝒰i(𝒂^𝒩iS,𝒂𝒩⁡(i)∖S)−𝒰i(𝒂𝒩⁡(i))\|\\displaystyle\\sum\_{\\begin{subarray}{c}S\\in{\\mathcal{S}}\\colon\\\<br>i\\in S\\end{subarray}}~\\frac{1}{\|S\|}\\sum\_{\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\in\\mathcal{A}\_{\\mathcal{N}\_{i}^{S}}}\\mu^{(t+1)}\\left(S,\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\right)\\left\|\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}},\\bm{a}\_{\\mathcal{N}(i)\\setminus S}\\right)-\\mathcal{U}\_{i}(\\bm{a}\_{\\mathcal{N}(i)})\\right\| |  |\
|  | ≤(i)\\displaystyle\\overset{(i)}{\\leq} | ∑S∈𝒮:i∈S1\|S\|∑𝒂^𝒩iS∈𝒜𝒩iSμ(t+1)(S,𝒂^𝒩iS).\\displaystyle\\sum\_{\\begin{subarray}{c}S\\in{\\mathcal{S}}\\colon\\\<br>i\\in S\\end{subarray}}~\\frac{1}{\|S\|}\\sum\_{\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\in\\mathcal{A}\_{\\mathcal{N}\_{i}^{S}}}\\mu^{(t+1)}\\left(S,\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\right). |  |\
\
(i)(i) is because 𝒰i​(𝒂𝒩⁡(i))∈\[0,1\]\\mathcal{U}\_{i}(\\bm{a}\_{\\mathcal{N}(i)})\\in\[0,1\] for any 𝒂𝒩⁡(i)∈𝒜𝒩⁡(i)\\bm{a}\_{\\mathcal{N}(i)}\\in\\mathcal{A}\_{\\mathcal{N}(i)}.\
\
Recall that by definition, 𝒂−B(t)=argmax𝒂−B∈𝒜−B∑i∈st​(B)ui(t)​(𝒂𝒩⁡(i))\\bm{a}\_{-B}^{(t)}=\\mathop{\\mathrm{argmax}}\_{\\bm{a}\_{-B}\\in\\mathcal{A}\_{-B}}\\sum\_{i\\in\\text{st}(B)}u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)}). Then,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | d(t)​(B,𝒂B)\\displaystyle d^{(t)}(B,\\bm{a}\_{B}) |  |\
|  | =\\displaystyle= | ∑i∈st​(B)ui(t)​((𝒂𝒩⁡(i)∩B,𝒂𝒩⁡(i)∖B(t)))\\displaystyle\\sum\_{i\\in\\text{st}(B)}u\_{i}^{(t)}\\left((\\bm{a}\_{\\mathcal{N}(i)\\cap B},\\bm{a}\_{\\mathcal{N}(i)\\setminus B}^{(t)})\\right) |  |\
|  | ≥\\displaystyle\\geq | ∑i∈st​(B)ui(t)​((𝒂𝒩⁡(i)∩B,𝒂𝒩⁡(i)∖B(t+1)))\\displaystyle\\sum\_{i\\in\\text{st}(B)}u\_{i}^{(t)}\\left((\\bm{a}\_{\\mathcal{N}(i)\\cap B},\\bm{a}\_{\\mathcal{N}(i)\\setminus B}^{(t+1)})\\right) |  |\
|  | =\\displaystyle= | ∑i∈st​(B)ui(t+1)​((𝒂𝒩⁡(i)∩B,𝒂𝒩⁡(i)∖B(t+1)))+(ui(t+1)​((𝒂𝒩⁡(i)∩B,𝒂𝒩⁡(i)∖B(t+1)))−ui(t)​((𝒂𝒩⁡(i)∩B,𝒂𝒩⁡(i)∖B(t+1))))\\displaystyle\\sum\_{i\\in\\text{st}(B)}u\_{i}^{(t+1)}\\left((\\bm{a}\_{\\mathcal{N}(i)\\cap B},\\bm{a}\_{\\mathcal{N}(i)\\setminus B}^{(t+1)})\\right)+\\left(u\_{i}^{(t+1)}\\left((\\bm{a}\_{\\mathcal{N}(i)\\cap B},\\bm{a}\_{\\mathcal{N}(i)\\setminus B}^{(t+1)})\\right)-u\_{i}^{(t)}\\left((\\bm{a}\_{\\mathcal{N}(i)\\cap B},\\bm{a}\_{\\mathcal{N}(i)\\setminus B}^{(t+1)})\\right)\\right) |  |\
|  | ≥\\displaystyle\\geq | ∑i∈st​(B)(ui(t+1)((𝒂𝒩⁡(i)∩B,𝒂𝒩⁡(i)∖B(t+1)))−∑S∈𝒮:i∈S1\|S\|∑𝒂^𝒩iS∈𝒜𝒩iSμ(t+1)(S,𝒂^𝒩iS))\\displaystyle\\sum\_{i\\in\\text{st}(B)}\\left(u\_{i}^{(t+1)}\\left((\\bm{a}\_{\\mathcal{N}(i)\\cap B},\\bm{a}\_{\\mathcal{N}(i)\\setminus B}^{(t+1)})\\right)-\\sum\_{\\begin{subarray}{c}S\\in{\\mathcal{S}}\\colon\\\<br>i\\in S\\end{subarray}}~\\frac{1}{\|S\|}\\sum\_{\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\in\\mathcal{A}\_{\\mathcal{N}\_{i}^{S}}}\\mu^{(t+1)}\\left(S,\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\right)\\right) |  |\
|  | =\\displaystyle= | d(t+1)​(B,𝒂B)−∑S∈𝒮1\|S\|​∑i∈S∩st​(B)∑𝒂^𝒩iS∈𝒜𝒩iSμ(t+1)​(S,𝒂^𝒩iS)\\displaystyle d^{(t+1)}(B,\\bm{a}\_{B})-\\sum\_{S\\in{\\mathcal{S}}}~\\frac{1}{\|S\|}\\sum\_{i\\in S\\cap\\text{st}(B)}~\\sum\_{\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\in\\mathcal{A}\_{\\mathcal{N}\_{i}^{S}}}\\mu^{(t+1)}\\left(S,\\widehat{\\bm{a}}\_{\\mathcal{N}\_{i}^{S}}\\right) |  |\
|  | ≥\\displaystyle\\geq | d(t+1)​(B,𝒂B)−1.\\displaystyle d^{(t+1)}(B,\\bm{a}\_{B})-1. |  |\
\
Similarly, we can get the upper bound that d(t)​(B,𝒂B)≤d(t+1)​(B,𝒂B)+1d^{(t)}(B,\\bm{a}\_{B})\\leq d^{(t+1)}(B,\\bm{a}\_{B})+1. Hence, the proof is completed.\
∎\
\
## Appendix G Efficient Update of μ\\mu\
\
This section provides the omitted details regarding the update procedure for μ\\mu and presents the complete proof of [Theorem7.3](https://arxiv.org/html/2604.28186v1#S7.theoremcounter3 "Theorem 7.3. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
### G.1 Efficient Update of μ\\mu\
\
The procedure for updating μ\\mu closely parallels that of π\\pi. Specifically, we iterate over all coalitions S∈𝒮S\\in{\\mathcal{S}} and, for each SS, determine the optimal action 𝒂S∈𝒜S\\bm{a}\_{S}\\in\\mathcal{A}\_{S}. To achieve this, we maintain a dynamic programming vector 𝒈S∈ℝ×B∈𝒯𝒜B\\bm{g}\_{S}\\in\\mathbb{R}^{\\bigtimes\_{B\\in{\\mathcal{T}}}\\mathcal{A}\_{B}} for each S∈𝒮S\\in{\\mathcal{S}}, which is updated according to\
\
|     |     |     |\
| --- | --- | --- |\
|  | gS(t+1)​(B,𝒂^B)=1\|S\|∑τ=1t∑i∈S:i​ assigned to ​B∑𝒂∈𝒜π(τ)(𝒂)(𝒰i(𝒂^B∩S,𝒂B∖S)−𝒰i(𝒂B))+∑B′∈C⁡(B)max𝒂^B′′∈𝒜B′:𝒂^B∩B′=𝒂^B∩B′′g(t+1)(B′,𝒂^B′′)+m(t+1)(B,𝒂^B).\\begin{split}g\_{S}^{(t+1)}(B,\\widehat{\\bm{a}}\_{B})=&\\frac{1}{\|S\|}\\sum\_{\\tau=1}^{t}\\sum\_{\\begin{subarray}{c}i\\in S\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}{\\color\[rgb\]{0,0,1}\\sum\_{\\bm{a}\\in\\mathcal{A}}}\\pi^{(\\tau)}(\\bm{a})\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{B\\cap S},\\bm{a}\_{B\\setminus S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\_{B}\\right)\\right)\\\<br>&+\\sum\_{B^{\\prime}\\in C(B)}\\max\_{\\begin{subarray}{c}\\widehat{\\bm{a}}\_{B^{\\prime}}^{\\prime}\\in\\mathcal{A}\_{B^{\\prime}}\\colon\\\<br>\\widehat{\\bm{a}}\_{B\\cap B^{\\prime}}=\\widehat{\\bm{a}}^{\\prime}\_{B\\cap B^{\\prime}}\\end{subarray}}g^{(t+1)}(B^{\\prime},\\widehat{\\bm{a}}\_{B^{\\prime}}^{\\prime})+m^{(t+1)}(B,\\widehat{\\bm{a}}\_{B}).\\end{split} |  |\
\
At first sight, the ∑𝒂∈𝒜\\sum\_{\\bm{a}\\in\\mathcal{A}} appears computationally prohibitive, since 𝒜\\mathcal{A} is exponentially large. Fortunately, the update becomes tractable once we recall that π(τ)\\pi^{(\\tau)} is always a pure strategy for τ≥1\\tau\\geq 1. Denote by 𝒂(τ)\\bm{a}^{(\\tau)} the joint action selected by π(τ)\\pi^{(\\tau)}. Then [SectionG.1](https://arxiv.org/html/2604.28186v1#A7.Ex1 "G.1 Efficient Update of 𝜇 ‣ Appendix G Efficient Update of 𝜇 ‣ Computing Equilibrium beyond Unilateral Deviation") simplifies to\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | gS(t+1)​(B,𝒂^B)=1\|S\|∑τ=1t∑i∈S:i​ assigned to ​B(𝒰i(𝒂^B∩S,𝒂B∖S(τ))−𝒰i(𝒂B(τ)))+∑B′∈C⁡(B)max𝒂^B′′∈𝒜B′:𝒂^B∩B′=𝒂^B∩B′′g(t+1)(B′,𝒂^B′′)+mS(t+1)(B,𝒂^B).\\begin{split}g\_{S}^{(t+1)}(B,\\widehat{\\bm{a}}\_{B})=&\\frac{1}{\|S\|}\\sum\_{\\tau=1}^{t}\\sum\_{\\begin{subarray}{c}i\\in S\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{B\\cap S},{\\color\[rgb\]{0,0,1}\\bm{a}\_{B\\setminus S}^{(\\tau)}}\\right)-\\mathcal{U}\_{i}\\left({\\color\[rgb\]{0,0,1}\\bm{a}\_{B}^{(\\tau)}}\\right)\\right)\\\<br>&+\\sum\_{B^{\\prime}\\in C(B)}\\max\_{\\begin{subarray}{c}\\widehat{\\bm{a}}\_{B^{\\prime}}^{\\prime}\\in\\mathcal{A}\_{B^{\\prime}}\\colon\\\<br>\\widehat{\\bm{a}}\_{B\\cap B^{\\prime}}=\\widehat{\\bm{a}}^{\\prime}\_{B\\cap B^{\\prime}}\\end{subarray}}g^{(t+1)}(B^{\\prime},\\widehat{\\bm{a}}\_{B^{\\prime}}^{\\prime})+m\_{S}^{(t+1)}(B,\\widehat{\\bm{a}}\_{B}).\\end{split} |  | (G.1) |\
\
After completing the dynamic programming updates, we focus on the root bag BrB^{r} of the tree decomposition. The selected coalition is then S(t+1)=argmaxS∈𝒮max𝒂^Br∈𝒜Br⁡gS(t+1)​(Br,𝒂^Br)S^{(t+1)}=\\allowbreak\\mathop{\\mathrm{argmax}}\_{S\\in{\\mathcal{S}}}\\allowbreak\\max\_{\\widehat{\\bm{a}}\_{B^{r}}\\in\\mathcal{A}\_{B^{r}}}\\allowbreak g\_{S}^{(t+1)}(B^{r},\\widehat{\\bm{a}}\_{B^{r}}). Next, we apply the reconstruction procedure in [7.6](https://arxiv.org/html/2604.28186v1#S7.E6 "In Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") on 𝒈S(t+1)(t+1)\\bm{g}\_{S^{(t+1)}}^{(t+1)} to extract a joint action 𝒂^(t+1)∈𝒜\\widehat{\\bm{a}}^{(t+1)}\\in\\mathcal{A}. Finally, we update μ(t+1)​(S(t+1),𝒂^(t+1))=1\\mu^{(t+1)}\\left(S^{(t+1)},\\widehat{\\bm{a}}^{(t+1)}\\right)=1.\
\
This procedure ensures that μ\\mu can be updated efficiently while maintaining consistency with the tree decomposition structure. Analogous to the update of π\\pi, the regret of this process can be bounded.\
\
### G.2 Proof of [Theorem7.3](https://arxiv.org/html/2604.28186v1\#S7.theoremcounter3 "Theorem 7.3. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
See [7.3](https://arxiv.org/html/2604.28186v1#S7.theoremcounter3 "Theorem 7.3. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
The proof of [Theorem7.3](https://arxiv.org/html/2604.28186v1#S7.theoremcounter3 "Theorem 7.3. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is similar to that of [Theorem7.2](https://arxiv.org/html/2604.28186v1#S7.theoremcounter2 "Theorem 7.2. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). By using a similar argument as the proof of [Theorem7.2](https://arxiv.org/html/2604.28186v1#S7.theoremcounter2 "Theorem 7.2. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"), for any μ^∈Δ×S∈𝒮𝒜S\\widehat{\\mu}\\in\\Delta^{\\bigtimes\_{S\\in{\\mathcal{S}}}\\mathcal{A}\_{S}}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | ∑t=1T(F⁡(π(t),μ^)−F⁡(π(t),μ(t)))\\displaystyle\\sum\_{t=1}^{T}\\left(F\\left(\\pi^{(t)},\\widehat{\\mu}\\right)-F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right) |  |\
|  | ≤\\displaystyle\\leq | ⟨𝒎~,μ^−μ(2)⟩+∑t=1T(F⁡(π(t),μ(t+1))−F⁡(π(t),μ(t))).\\displaystyle\\left\\langle\\widetilde{\\bm{m}},\\widehat{\\mu}-\\mu^{(2)}\\right\\rangle+\\sum\_{t=1}^{T}\\left(F\\left(\\pi^{(t)},\\mu^{(t+1)}\\right)-F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right). |  |\
\
Next, by introducing the counterpart of [LemmaF.3](https://arxiv.org/html/2604.28186v1#A6.theoremcounter3 "Lemma F.3. ‣ F.3 Sublinear Variation ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation") in the following, the rest of the proof follows that of [Theorem7.2](https://arxiv.org/html/2604.28186v1#S7.theoremcounter2 "Theorem 7.2. ‣ Reconstructing the strategy. ‣ 7.2 Efficient Update of 𝜋 ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
###### Lemma G.1.\
\
Consider the update rule [7.3](https://arxiv.org/html/2604.28186v1#S7.E3 "In 7.1 Meta-Game between the Correlator and Deviator ‣ 7 Efficient Computation of MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). For any timestep t=1,2,…,Tt=1,2,\\dots,T, bag B∈𝒯B\\in{\\mathcal{T}}, joint action 𝒂^B∈𝒜B\\widehat{\\bm{a}}\_{B}\\in\\mathcal{A}\_{B}, coalition S∈𝒮S\\in{\\mathcal{S}}, and noise 𝒎~∈ℝ×B∈𝒯𝒜B\\widetilde{\\bm{m}}\\in\\mathbb{R}^{\\bigtimes\_{B\\in{\\mathcal{T}}}\\mathcal{A}\_{B}}, we have\
\
|     |     |     |\
| --- | --- | --- |\
|  | \|gS(t+1)​(B,𝒂^B)−gS(t)​(B,𝒂^B)\|≤1.\\displaystyle\\left\|g\_{S}^{(t+1)}(B,\\widehat{\\bm{a}}\_{B})-g\_{S}^{(t)}(B,\\widehat{\\bm{a}}\_{B})\\right\|\\leq 1. |  |\
\
The proof is postponed to the end of this section.\
Let S(t),𝒂^(t)S^{(t)},\\widehat{\\bm{a}}^{(t)} denote the coalition and action the deviator picks at timestep tt, _i.e._, μ(t)​(S(t),𝒂^(t))=1\\mu^{(t)}\\left(S^{(t)},\\widehat{\\bm{a}}^{(t)}\\right)=1. Then,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | 𝔼⁡\[F⁡(π(t),μ(t+1))−F⁡(π(t),μ(t))\]\\displaystyle\\mathbb{E}\\left\[F\\left(\\pi^{(t)},\\mu^{(t+1)}\\right)-F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right\] |  |\
|  | ≤\\displaystyle\\leq | Pr𝒎~⁡(μ(t+1)≠μ(t))\\displaystyle\\Pr\_{\\widetilde{\\bm{m}}}\\left(\\mu^{(t+1)}\\not=\\mu^{(t)}\\right) |  |\
|  | =\\displaystyle= | Pr𝒎~⁡(S(t)=S(t+1))​∏B∈𝒯Pr𝒎~⁡(𝒂^B∖f​a​(B)(t)=𝒂^B∖f​a​(B)(t+1)\|𝒂^f​a​(B)(t)=𝒂^f​a​(B)(t+1),S(t)=S(t+1))\\displaystyle\\Pr\_{\\widetilde{\\bm{m}}}\\left(S^{(t)}=S^{(t+1)}\\right)\\prod\_{B\\in{\\mathcal{T}}}\\Pr\_{\\widetilde{\\bm{m}}}\\left(\\widehat{\\bm{a}}\_{B\\setminus fa(B)}^{(t)}=\\widehat{\\bm{a}}\_{B\\setminus fa(B)}^{(t+1)}{\\,\\big\|\\,}\\widehat{\\bm{a}}\_{fa(B)}^{(t)}=\\widehat{\\bm{a}}\_{fa(B)}^{(t+1)},S^{(t)}=S^{(t+1)}\\right) |  |\
|  | ≤(i)\\displaystyle\\overset{(i)}{\\leq} | 1−exp⁡(2​η​\|𝒯\|).\\displaystyle 1-\\exp\\left(2\\eta\|{\\mathcal{T}}\|\\right). |  |\
\
(i)(i) is because choosing S(t)S^{(t)} is equivalent to adding a new player in the root bag BrB^{r}, whose action is to select the coalition. Finally, for any δ>0\\delta>0, with probability at least 1−δ1-\\delta,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | ∑t=1T(F⁡(π(t),μ^)−F⁡(π(t),μ(t)))\\displaystyle\\sum\_{t=1}^{T}\\left(F\\left(\\pi^{(t)},\\widehat{\\mu}\\right)-F\\left(\\pi^{(t)},\\mu^{(t)}\\right)\\right) |  |\
|  | ≤\\displaystyle\\leq | 2​\|𝒯\|​1+(tw⁡(𝒢)+1)​log⁡Aη+2​η​\|𝒯\|​T+2​T​log⁡1δ.∎\\displaystyle 2\\left\|{\\mathcal{T}}\\right\|\\frac{1+\\left({\\rm tw}(\\mathcal{G})+1\\right)\\log A}{\\eta}+2\\eta\\left\|{\\mathcal{T}}\\right\|T+\\sqrt{2T\\log\\frac{1}{\\delta}}.\\qed |  |\
\
### G.3 Proof of Auxiliary Lemmas\
\
See [G.1](https://arxiv.org/html/2604.28186v1#A7.theoremcounter1 "Lemma G.1. ‣ Proof. ‣ G.2 Proof of ‣ Appendix G Efficient Update of 𝜇 ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
For any S∈𝒮S\\in{\\mathcal{S}}, the upper bound of \|gS(t+1)​(B,𝒂^B)−gS(t)​(B,𝒂^B)\|\\left\|g\_{S}^{(t+1)}(B,\\widehat{\\bm{a}}\_{B})-g\_{S}^{(t)}(B,\\widehat{\\bm{a}}\_{B})\\right\| can be obtained similarly to the proof of [LemmaF.3](https://arxiv.org/html/2604.28186v1#A6.theoremcounter3 "Lemma F.3. ‣ F.3 Sublinear Variation ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation") by choosing\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | ui(t)(𝒂𝒩⁡(i))=1\|S\|∑τ=1t∑i∈S:i​ assigned to ​B∑𝒂∈𝒜π(τ)(𝒂)(𝒰i(𝒂^B∩S,𝒂B∖S)−𝒰i(𝒂B)) for i∈\[N\]\\displaystyle u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)})=\\frac{1}{\|S\|}\\sum\_{\\tau=1}^{t}\\sum\_{\\begin{subarray}{c}i\\in S\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi^{(\\tau)}(\\bm{a})\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{B\\cap S},\\bm{a}\_{B\\setminus S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\_{B}\\right)\\right)\\text{ for }i\\in\[N\] |  |\
|  |  | ui(t)​(𝒂𝒩⁡(i))=mS​(B,𝒂𝒩⁡(i))​ for i as the noise player assigned to bag ​B.\\displaystyle u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)})=m\_{S}(B,\\bm{a}\_{\\mathcal{N}(i)})\\text{ for $i$ as the noise player assigned to bag }B. |  |\
\
Then,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | \|ui(t)​(𝒂𝒩⁡(i))−ui(t+1)​(𝒂𝒩⁡(i))\|=\\displaystyle\\left\|u\_{i}^{(t)}(\\bm{a}\_{\\mathcal{N}(i)})-u\_{i}^{(t+1)}(\\bm{a}\_{\\mathcal{N}(i)})\\right\|= | \|1\|S\|∑i∈S:i​ assigned to ​B∑𝒂∈𝒜π(t+1)(𝒂)(𝒰i(𝒂^B∩S,𝒂B∖S)−𝒰i(𝒂B))\|\\displaystyle\\left\|\\frac{1}{\|S\|}\\sum\_{\\begin{subarray}{c}i\\in S\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi^{(t+1)}(\\bm{a})\\left(\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{B\\cap S},\\bm{a}\_{B\\setminus S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\_{B}\\right)\\right)\\right\| |  |\
|  | ≤(i)\\displaystyle\\overset{(i)}{\\leq} | 1\|S\|∑i∈S:i​ assigned to ​B∑𝒂∈𝒜π(t+1)(𝒂).\\displaystyle\\frac{1}{\|S\|}\\sum\_{\\begin{subarray}{c}i\\in S\\colon\\\<br>i\\text{ assigned to }B\\end{subarray}}\\sum\_{\\bm{a}\\in\\mathcal{A}}\\pi^{(t+1)}(\\bm{a}). |  |\
\
(i)(i) is by the fact that 𝒰i​(𝒂^B∩S,𝒂B∖S),𝒰i​(𝒂B)∈\[0,1\]\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{B\\cap S},\\bm{a}\_{B\\setminus S}\\right),\\mathcal{U}\_{i}\\left(\\bm{a}\_{B}\\right)\\in\[0,1\]. The rest of the proof follows that of [LemmaF.3](https://arxiv.org/html/2604.28186v1#A6.theoremcounter3 "Lemma F.3. ‣ F.3 Sublinear Variation ‣ Appendix F Proof of ‣ Computing Equilibrium beyond Unilateral Deviation"), and thus we complete the proof.\
∎\
\
## Appendix H Additional Experimental Results\
\
In this section, we detail our experimental setup and report additional results for two further games: the Chicken game ( [Bergstrom and Godfrey-Smith, 1998](https://arxiv.org/html/2604.28186v1#bib.bib7 "")) and Pigou’s network ( [Pigou, 2017](https://arxiv.org/html/2604.28186v1#bib.bib38 "")). All experiments are conducted on a 13th Gen Intel(R) Core(TM) i7-13700K @ 3.40 GHz. Error bars for MASE and FTPL indicate ±1​σ\\pm 1\\sigma over 100100 random seeds (0,1,…,990,1,\\dots,99). Across all experiments, we set the learning rate to η=0.01\\eta=0.01 and run for T=10,000T=10,000 timesteps.\
\
### H.1 Experimental Details\
\
For all baselines, we run each algorithm independently for each player, thus the average strategy converges to a CCE ( [Hazan et al., 2016](https://arxiv.org/html/2604.28186v1#bib.bib23 "")). For FTRL, Hedge, and OMD, each player i∈\[N\]i\\in\[N\] is initialized with a uniform distribution πi(1)\\pi\_{i}^{(1)} over all actions. MASE and FTPL are initialized with a pure strategy chosen uniformly at random from all pure strategies.\
\
### H.2 Utility Functions\
\
This subsection specifies the utility functions for all four games.\
\
#### Prisoner’s Dilemma.\
\
The utility matrix is shown in [Table2](https://arxiv.org/html/2604.28186v1#A8.T2 "In Prisoner’s Dilemma. ‣ H.2 Utility Functions ‣ Appendix H Additional Experimental Results ‣ Computing Equilibrium beyond Unilateral Deviation"). If both prisoners confess, they receive reduced sentences. If one confesses while the other defects, the confessor is imprisoned and the defector is released immediately. If both defect, both are imprisoned for longer than in the mutual-confession case to penalize dishonesty.\
\
|     |     |     |\
| --- | --- | --- |\
|  | Confess (C) | Defect (D) |\
| Confess (C) | (0.6,0.6)(0.6,0.6) | (0,1)(0,1) |\
| Defect (D) | (1,0)(1,0) | (0.2,0.2)(0.2,0.2) |\
\
Table 2: Utility matrix of Prisoner’s Dilemma. Each entry (a,b)(a,b) denotes the payoffs to the row player (aa) and the column player (bb).\
\
#### Stag Hunt.\
\
The utility matrix is shown in [Table3](https://arxiv.org/html/2604.28186v1#A8.T3 "In Stag Hunt. ‣ H.2 Utility Functions ‣ Appendix H Additional Experimental Results ‣ Computing Equilibrium beyond Unilateral Deviation"). A stag yields a higher reward, but it can only be hunted successfully if both players choose Stag; a solo stag attempt yields nothing. A hare provides a smaller payoff but can be secured by a single player.\
\
|     |     |     |\
| --- | --- | --- |\
|  | Stag (S) | Hare (H) |\
| Stag (S) | (1,1)(1,1) | (0.1,0.8)(0.1,0.8) |\
| Hare (H) | (0.8,0.1)(0.8,0.1) | (0.5,0.5)(0.5,0.5) |\
\
Table 3: Utility matrix of the Stag Hunt. Each entry (a,b)(a,b) denotes the payoff of the row player (aa) and the column player (bb).\
\
#### Chicken Game.\
\
Two drivers head toward each other and can either swerve or go straight. If one goes straight while the other swerves, the swerving player "loses". If both go straight, they crash.\
\
|     |     |     |\
| --- | --- | --- |\
|  | Swerve (Sw) | Straight (St) |\
| Swerve (Sw) | (5/6,5/6)(5/6,5/6) | (2/3,1)(2/3,1) |\
| Straight (St) | (1,2/3)(1,2/3) | (0,0)(0,0) |\
\
Table 4: Utility matrix of the Chicken game. Each entry (a,b)(a,b) denotes the payoff of the row player (aa) and the column player (bb).\
\
#### Pigou Network.\
\
We use a three-player variant of Pigou’s network. Each player chooses a _fast_ or _slow_ route. The slow route yields a constant utility of 0.250.25. The fast route yields utility 1.5−0.5⋅(number of players choosing the fast route)1.5-0.5\\cdot(\\text{number of players choosing the fast route}), reflecting congestion.\
\
### H.3 Additional Experimental Results\
\
[Figure8](https://arxiv.org/html/2604.28186v1#A8.F8 "In H.3 Additional Experimental Results ‣ Appendix H Additional Experimental Results ‣ Computing Equilibrium beyond Unilateral Deviation") reports additional experiments on the Chicken game and Pigou’s network. MASE consistently outperforms the baselines in both coalition exploitability and social welfare. In Pigou’s network, purely self-interested players overuse the fast route, which in equilibrium becomes slow. By contrast, when players form coalitions and consider average utility within a coalition, they share the routes so that everyone is better off.\
\
Figure 8: LP refers to the linear program in [AppendixA](https://arxiv.org/html/2604.28186v1#A1 "Appendix A Linear Programming for Solving ‣ Computing Equilibrium beyond Unilateral Deviation"). Maximum marks the maximum social welfare. MASE outperforms the baselines in both games in terms of coalition exploitability and social welfare.\
\
[Figure9](https://arxiv.org/html/2604.28186v1#A8.F9 "In H.3 Additional Experimental Results ‣ Appendix H Additional Experimental Results ‣ Computing Equilibrium beyond Unilateral Deviation") shows the trade-off between exploitability and social welfare in the Chicken game and Pigou’s network.\
\
Figure 9: The trade-off between exploitability and social welfare in the Chicken game and the Pigou’s network.\
\
[Figure10](https://arxiv.org/html/2604.28186v1#A8.F10 "In H.3 Additional Experimental Results ‣ Appendix H Additional Experimental Results ‣ Computing Equilibrium beyond Unilateral Deviation") reports the runtime of the algorithm for polymatrix games with varying numbers of players, action set sizes, and interaction densities.\
\
Figure 10: The runtime of the algorithm in different polymatrix games.\
\
## Appendix I Polymatrix Games\
\
In this section, we present experimental details for MASE on games with a larger number of players. We select polymatrix games as the benchmark for these large-scale experiments. This choice is motivated by their inherent graphical structure, which allows for the efficient generation of instances with a low treewidth of their [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
We begin with the formal definition. A polymatrix game has a corresponding undirected graph 𝒢U=(𝒱U,ℰU)\\mathcal{G}^{U}=(\\mathcal{V}^{U},\\mathcal{E}^{U}), with 𝒱U=\[N\]\\mathcal{V}^{U}=\[N\]. For any joint action 𝒂∈𝒜\\bm{a}\\in\\mathcal{A}, the utility of any player ii is defined as:\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | 𝒰i​(𝒂)≔∑(i,j)∈ℰU𝒰i,j​(ai,aj),\\displaystyle\\mathcal{U}\_{i}(\\bm{a})\\coloneqq\\sum\_{(i,j)\\in\\mathcal{E}^{U}}\\mathcal{U}\_{i,j}(a\_{i},a\_{j}), |  | (I.1) |\
\
where 𝒰i,j:𝒜i×𝒜j→\[0,1\]\\mathcal{U}\_{i,j}\\colon\\mathcal{A}\_{i}\\times\\mathcal{A}\_{j}\\to\[0,1\] represents the interaction between players ii and jj. In other words, only players who are connected in 𝒢U\\mathcal{G}^{U} interact, and a player’s total utility is the summation of these pairwise interactions.\
\
If we construct the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") directly, then the tree decomposition may explode unwillingly, _e.g._, [Figure11](https://arxiv.org/html/2604.28186v1#A9.F11 "In Appendix I Polymatrix Games ‣ Computing Equilibrium beyond Unilateral Deviation") (a). We can see that the treewidth of 𝒢U\\mathcal{G}^{U} is one while the treewidth of the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") is three.\
\
Constructing the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") directly from the polymatrix game can cause its treewidth to explode. For example, in [Figure11](https://arxiv.org/html/2604.28186v1#A9.F11 "In Appendix I Polymatrix Games ‣ Computing Equilibrium beyond Unilateral Deviation") (a), the original graph 𝒢U\\mathcal{G}^{U} has a treewidth of one, while the resulting [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") has a treewidth of three.\
\
To prevent this, we construct a strategically equivalent game (note that this new game is _not_ a polymatrix game). This construction explicitly models the pairwise interactions as new players:\
\
- •\
\
\
For any original edge (i,j)∈ℰU(i,j)\\in\\mathcal{E}^{U}, we introduce two edge players, ei,je\_{i,j} and ej,ie\_{j,i}.\
\
- •\
\
\
Each edge player ei,je\_{i,j} has a singleton action set, \|𝒜ei,j\|=1\\left\|\\mathcal{A}\_{e\_{i,j}}\\right\|=1, meaning it has only a single strategy.\
\
- •\
\
\
The utility function of an edge player ei,je\_{i,j} is defined as the original interaction utility: 𝒰~ei,j=𝒰i,j\\widetilde{\\mathcal{U}}\_{e\_{i,j}}=\\mathcal{U}\_{i,j}.\
\
- •\
\
\
The utility function of an original vertex player ii (one of the original NN players) is now a constant zero: 𝒰~i≡0\\widetilde{\\mathcal{U}}\_{i}\\equiv 0.\
\
\
This transformation is illustrated in [Figure11](https://arxiv.org/html/2604.28186v1#A9.F11 "In Appendix I Polymatrix Games ‣ Computing Equilibrium beyond Unilateral Deviation") (b). The [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation") for this new game, shown on the right of [Figure11](https://arxiv.org/html/2604.28186v1#A9.F11 "In Appendix I Polymatrix Games ‣ Computing Equilibrium beyond Unilateral Deviation") (b), now has a treewidth of max⁡(tw⁡(𝒢U),2)\\max\\left({\\rm tw}(\\mathcal{G}^{U}),2\\right). This method effectively bounds the treewidth and avoids the undesirable explosion.\
\
Figure 11: (a) The original graph 𝒢U\\mathcal{G}^{U} corresponding to the polymatrix game (left) and the [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation"). (b) The strategically equivalent game and its [Utility Dependency Graph](https://arxiv.org/html/2604.28186v1#S6.I1.i1 "In Definition 6.2 (Utility Dependency Graph). ‣ 6.1 Lower Bound on the Exponential Dependence on Treewidth ‣ 6 Hardness of Computing MASE ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
Next, we show that the new game and the original polymatrix game are strategically equivalent. In other words, for any joint strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}}, the maximum average deviation gain, maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\max\_{S\\in{\\mathcal{S}}}\\allowbreak\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\allowbreak\\frac{1}{\|S\|}\\sum\_{i\\in S}\\allowbreak\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\], does not change. Recall that since the edge players have only a single action, π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}} (a distribution over the original players’ joint actions) is sufficient to specify the joint strategy in both games.\
\
###### Lemma I.1.\
\
The new game described above is equivalent to the original polymatrix game, when 𝒮~={S∪{ei,j}i∈S∧(i,j)∈ℰU}S∈𝒮\\widetilde{\\mathcal{S}}=\\left\\{S\\cup\\left\\{e\_{i,j}\\right\\}\_{i\\in S\\wedge(i,j)\\in\\mathcal{E}^{U}}\\right\\}\_{S\\in{\\mathcal{S}}}. Formally, for any joint strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =\\displaystyle= | maxS~∈𝒮~⁡max𝒂^S~∈𝒜S~​1\|S~∩\[N\]\|​∑i∈S~𝔼𝒂∼π​\[𝒰~i​(𝒂^S~∩\[N\],𝒂−(S~∩\[N\]))−𝒰~i​(𝒂)\].\\displaystyle\\max\_{\\widetilde{S}\\in\\widetilde{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{\\widetilde{S}}\\in\\mathcal{A}\_{\\widetilde{S}}}\\frac{1}{\|\\widetilde{S}\\cap\[N\]\|}\\sum\_{i\\in\\widetilde{S}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\widetilde{\\mathcal{U}}\_{i}\\left(\\widehat{\\bm{a}}\_{\\widetilde{S}\\cap\[N\]},\\bm{a}\_{-(\\widetilde{S}\\cap\[N\])}\\right)-\\widetilde{\\mathcal{U}}\_{i}\\left(\\bm{a}\\right)\\right\]. |  |\
\
The proof is postponed to the end of this section. This equivalence allows us to solve the new game instead of the original one. Our algorithm can minimize a more general objective, maxS∈𝒮⁡max𝒂^S∈𝒜S​wS​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\max\_{S\\in{\\mathcal{S}}}\\allowbreak\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\allowbreak w\_{S}\\allowbreak\\sum\_{i\\in S}\\allowbreak\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\], for any weight vector 𝒘∈ℝS\\bm{w}\\in\\mathbb{R}^{S}.131313\
\
\
\
\
\
\
\
Both the implementation and the proof only use the linearity of the objective. Hence, any weighted sum can fit into the framework. We can therefore apply our algorithm to this new, strategically equivalent game.\
\
### I.1 Experimental Details\
\
We generate random polymatrix games using the following procedure:\
\
- •\
\
\
Each pair of players (i,j)(i,j) is connected independently with probability cN−1\\frac{c}{N-1}, where NN is the total number of players. This results in an expected degree of cc for each player in 𝒢U\\mathcal{G}^{U}.\
\
- •\
\
\
For each connected pair (i,j)(i,j), the interaction utilities 𝒰i,j​(ai,aj)\\mathcal{U}\_{i,j}(a\_{i},a\_{j}) are sampled independently and uniformly from \[0,1\]\[0,1\] for all action pairs ai∈𝒜i,aj∈𝒜ja\_{i}\\in\\mathcal{A}\_{i},a\_{j}\\in\\mathcal{A}\_{j}. These pairwise utilities are then normalized according to the formula:\
\
\
\
|     |     |     |\
| --- | --- | --- |\
|  | 𝒰i,j​(ai,aj)−mink∈\[N\],𝒂^∈𝒜⁡𝒰k​(𝒂^)maxk∈\[N\],𝒂^∈𝒜⁡𝒰k​(𝒂^)−mink∈\[N\],𝒂^∈𝒜⁡𝒰k​(𝒂^).\\displaystyle\\frac{\\mathcal{U}\_{i,j}(a\_{i},a\_{j})-\\min\_{k\\in\[N\],\\widehat{\\bm{a}}\\in\\mathcal{A}}\\mathcal{U}\_{k}(\\widehat{\\bm{a}})}{\\max\_{k\\in\[N\],\\widehat{\\bm{a}}\\in\\mathcal{A}}\\mathcal{U}\_{k}(\\widehat{\\bm{a}})-\\min\_{k\\in\[N\],\\widehat{\\bm{a}}\\in\\mathcal{A}}\\mathcal{U}\_{k}(\\widehat{\\bm{a}})}. |  |\
\
\
\
This process ensures that the final total utility 𝒰i​(𝒂)\\mathcal{U}\_{i}(\\bm{a}) for any player i∈\[N\]i\\in\[N\] and joint action 𝒂∈𝒜\\bm{a}\\in\\mathcal{A} falls within the within the range \[0,1\]\[0,1\].\
\
\
Consistent with the experiments on small games, we average the results over _100 runs_ for each hyper-parameter setting (using seeds 0–99). All algorithms use a learning rate of η=0.01\\eta=0.01, and error bars represent 1​σ1~\\sigma. For these larger games, we set the number of timesteps to T=100,000T=100,000 and a uniform action set size \|𝒜i\|=A\\left\|\\mathcal{A}\_{i}\\right\|=A for all players i∈\[N\]i\\in\[N\].\
\
The hyper-parameters for the ablation studies are as follows:\
\
- •\
\
\
Ablation on NN: A=2A=2 and c=1c=1.\
\
- •\
\
\
Ablation on AA: N=30N=30 and c=1c=1.\
\
- •\
\
\
Ablation on cc: N=30N=30 and A=2A=2.\
\
\
Furthermore, to accelerate the algorithm, without loss of generality, we only need to consider 𝒮={{i}}i∈\[N\]∪{{i,j}\|i,j∈\[N\],(i,j)∈𝒢U}{\\mathcal{S}}=\\left\\{\\left\\{i\\right\\}\\right\\}\_{i\\in\[N\]}\\cup\\left\\{\\left\\{i,j\\right\\}{\\,\|\\,}i,j\\in\[N\],(i,j)\\in\\mathcal{G}^{U}\\right\\} to minimize the coalition exploitability for any coalitions with no more than two players. In other words, for coalitions of two players, we only need to consider the case when they are connected in 𝒢U\\mathcal{G}^{U}. As shown in the following lemma.\
\
###### Lemma I.2.\
\
For any joint strategy π∈Δ𝒜\\pi\\in\\Delta^{\\mathcal{A}}, by letting 𝒮={{i}}i∈\[N\]∪{{i,j}\|i,j∈\[N\]∧(i,j)∈𝒢U}{\\mathcal{S}}=\\left\\{\\left\\{i\\right\\}\\right\\}\_{i\\in\[N\]}\\cup\\left\\{\\left\\{i,j\\right\\}{\\,\|\\,}i,j\\in\[N\]\\wedge(i,j)\\in\\mathcal{G}^{U}\\right\\}, we have\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | maxS∈𝒮⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\]\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =\\displaystyle= | maxS∈{{i}}i∈\[N\]∪{{i,j}\|i,j∈\[N\]∧i≠j}⁡max𝒂^S∈𝒜S​1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\].\\displaystyle\\max\_{\\begin{subarray}{c}S\\in\\left\\{\\left\\{i\\right\\}\\right\\}\_{i\\in\[N\]}\\\<br>\\cup\\left\\{\\left\\{i,j\\right\\}{\\,\|\\,}i,j\\in\[N\]\\wedge i\\not=j\\right\\}\\end{subarray}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]. |  |\
\
The proof is postponed to the end of this section.\
\
### I.2 Proof of the Auxiliary Lemma\
\
See [I.1](https://arxiv.org/html/2604.28186v1#A9.theoremcounter1 "Lemma I.1. ‣ Appendix I Polymatrix Games ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
For any S∈𝒮S\\in{\\mathcal{S}}, let S~\\widetilde{S} be its correspondence in 𝒮~\\widetilde{\\mathcal{S}}. Then,\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | max𝒂^S~∈𝒜S~⁡1\|S~∩\[N\]\|​∑i∈S~𝔼𝒂∼π​\[𝒰~i​(𝒂^S~∩\[N\],𝒂−(S~∩\[N\]))−𝒰~i​(𝒂)\]\\displaystyle\\max\_{\\widehat{\\bm{a}}\_{\\widetilde{S}}\\in\\mathcal{A}\_{\\widetilde{S}}}\\frac{1}{\|\\widetilde{S}\\cap\[N\]\|}\\sum\_{i\\in\\widetilde{S}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\widetilde{\\mathcal{U}}\_{i}\\left(\\widehat{\\bm{a}}\_{\\widetilde{S}\\cap\[N\]},\\bm{a}\_{-(\\widetilde{S}\\cap\[N\])}\\right)-\\widetilde{\\mathcal{U}}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =(i)\\displaystyle\\overset{(i)}{=} | max𝒂^S∈𝒜S⁡1\|S\|​∑i∈S~𝔼𝒂∼π​\[𝒰~i​(𝒂^S,𝒂−S)−𝒰~i​(𝒂)\]\\displaystyle\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in\\widetilde{S}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\widetilde{\\mathcal{U}}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\widetilde{\\mathcal{U}}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =(i​i)\\displaystyle\\overset{(ii)}{=} | max𝒂^S∈𝒜S1\|S\|∑i∈S∑j:(i,j)∈ℰU𝔼𝒂∼π\[𝒰~ei,j(𝒂^S,𝒂−S)−𝒰~ei,j(𝒂)\]\\displaystyle\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}~\\sum\_{j\\colon(i,j)\\in\\mathcal{E}^{U}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\widetilde{\\mathcal{U}}\_{e\_{i,j}}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\widetilde{\\mathcal{U}}\_{e\_{i,j}}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =(i​i​i)\\displaystyle\\overset{(iii)}{=} | max𝒂^S∈𝒜S⁡1\|S\|​∑i∈S𝔼𝒂∼π​\[𝒰i​(𝒂^S,𝒂−S)−𝒰i​(𝒂)\].\\displaystyle\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]. |  |\
\
(i)(i) uses the fact that \|𝒜ei,j\|=1\|\\mathcal{A}\_{e\_{i,j}}\|=1 and S~∩\[N\]=S\\widetilde{S}\\cap\[N\]=S. (i​i)(ii) is because 𝒰i≡0\\mathcal{U}\_{i}\\equiv 0 for any i∈\[N\]i\\in\[N\]. (i​i​i)(iii) is by the definition of 𝒰~ei,j\\widetilde{\\mathcal{U}}\_{e\_{i,j}} and S~\\widetilde{S}.\
∎\
\
See [I.2](https://arxiv.org/html/2604.28186v1#A9.theoremcounter2 "Lemma I.2. ‣ I.1 Experimental Details ‣ Appendix I Polymatrix Games ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
For any disconnected players i,ji,j and S={i,j}S=\\left\\{i,j\\right\\}, we can see that\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | max𝒂^S∈𝒜S⁡1\|S\|​∑k∈S𝔼𝒂∼π​\[𝒰k​(𝒂^S,𝒂−S)−𝒰k​(𝒂)\]\\displaystyle\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{1}{\|S\|}\\sum\_{k\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{k}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{k}\\left(\\bm{a}\\right)\\right\] |  |\
|  | ≤\\displaystyle\\leq | max𝒂^S∈𝒜S⁡maxk∈S​𝔼𝒂∼π​\[𝒰k​(𝒂^S,𝒂−S)−𝒰k​(𝒂)\]\\displaystyle\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\max\_{k\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{k}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{k}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =\\displaystyle= | maxk∈S⁡max𝒂^S∈𝒜S​𝔼𝒂∼π​\[𝒰k​(𝒂^S,𝒂−S)−𝒰k​(𝒂)\]\\displaystyle\\max\_{k\\in S}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{k}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{k}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =\\displaystyle= | maxk∈Smax𝒂^S∈𝒜S𝔼𝒂∼π\[∑k′∈\[N\]:(k,k′)∈𝒢U𝒰k,k′(𝒂^S,𝒂−S)−𝒰k,k′(𝒂)\]\\displaystyle\\max\_{k\\in S}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\sum\_{k^{\\prime}\\in\[N\]\\colon(k,k^{\\prime})\\in\\mathcal{G}^{U}}\\mathcal{U}\_{k,k^{\\prime}}\\left(\\widehat{\\bm{a}}\_{S},\\bm{a}\_{-S}\\right)-\\mathcal{U}\_{k,k^{\\prime}}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =(i)\\displaystyle\\overset{(i)}{=} | maxk∈Smax𝒂^S∈𝒜S𝔼𝒂∼π\[∑k′∈\[N\]:(k,k′)∈𝒢U𝒰k,k′(𝒂^k,𝒂−k)−𝒰k,k′(𝒂)\]\\displaystyle\\max\_{k\\in S}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\sum\_{k^{\\prime}\\in\[N\]\\colon(k,k^{\\prime})\\in\\mathcal{G}^{U}}\\mathcal{U}\_{k,k^{\\prime}}\\left(\\widehat{\\bm{a}}\_{k},\\bm{a}\_{-k}\\right)-\\mathcal{U}\_{k,k^{\\prime}}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =\\displaystyle= | maxk∈S⁡max𝒂^S∈𝒜S​𝔼𝒂∼π​\[𝒰k​(𝒂^k,𝒂−k)−𝒰k​(𝒂)\].\\displaystyle\\max\_{k\\in S}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\mathbb{E}\_{\\bm{a}\\sim\\pi}\\left\[\\mathcal{U}\_{k}\\left(\\widehat{\\bm{a}}\_{k},\\bm{a}\_{-k}\\right)-\\mathcal{U}\_{k}\\left(\\bm{a}\\right)\\right\]. |  |\
\
(i)(i) is because k′∉Sk^{\\prime}\\not\\in S since k∈S={i,j}k\\in S=\\left\\{i,j\\right\\} and i,ji,j are not connected. Therefore, since the coalition exploitability of SS is upper bounded by the maximum of that of coalitions {i}\\left\\{i\\right\\} and {j}\\left\\{j\\right\\}, we do not need to consider {i,j}\\left\\{i,j\\right\\}.\
\
Actually, the argument can be generalized to coalitions of any size MM. If we want to consider the coalition exploitability for coalitions no more than size MM, then we only need to consider all connected coalitions of size no more than size MM by an induction similar to the proof above.\
∎\
\
## Appendix J Omitted Proofs for [Section9](https://arxiv.org/html/2604.28186v1\#S9 "9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
See [9.2](https://arxiv.org/html/2604.28186v1#S9.theoremcounter2 "Lemma 9.2. ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
First, note that the set of ϵ\\epsilon-CCEs is a polytope. In particular, it can be written as\
\
|     |     |     |\
| --- | --- | --- |\
|  | ϵ-CCE={𝟏⊤π=1∧𝑩π≤ϵ∧π≥0},\\epsilon\\text{-CCE}=\\left\\{{\\bm{1}}^{\\top}\\pi=1\ \\wedge\ \\bm{B}\\pi\\leq\\epsilon\ \\wedge\ \\pi\\geq 0\\right\\}, |  |\
\
where 𝟏∈ℝ𝒜{\\bm{1}}\\in\\mathbb{R}^{\\mathcal{A}} denotes the all-ones vector. Moreover, social welfare is linear in π\\pi, and can be expressed as 𝒄⊤​π\\bm{c}^{\\top}\\pi for some vector 𝒄∈ℝ𝒜\\bm{c}\\in\\mathbb{R}^{\\mathcal{A}}. Hence, for a fixed ϵ\\epsilon, computing an optimal π∈ϵ​-CCE\\pi\\in\\epsilon\\text{-CCE} is equivalent to the linear program\
\
|     |     |     |     |     |\
| --- | --- | --- | --- | --- |\
|  |  | max⁡𝒄⊤​π\\displaystyle\\max\\bm{c}^{\\top}\\pi |  |\
|  | s.t. | 𝟏⊤​π=1\\displaystyle{\\bm{1}}^{\\top}\\pi=1 |  | (Primal) |\
|  |  | 𝑩​π≤ϵ\\displaystyle\\bm{B}\\pi\\leq\\epsilon |  |\
|  |  | π≥0.\\displaystyle\\pi\\geq 0. |  |\
\
As the feasible set expands with increasing ϵ\\epsilon, the EWF is non-decreasing. The dual of the linear program above is\
\
|     |     |     |     |     |\
| --- | --- | --- | --- | --- |\
|  | minλ,𝝁\\displaystyle\\min\_{\\lambda,\\bm{\\mu}}\\quad | λ+ϵ⋅𝟏⊤​𝝁\\displaystyle\\lambda+\\epsilon\\cdot{\\bm{1}}^{\\top}\\bm{\\mu} |  |\
|  | s.t. | λ​ 1+𝑩⊤​𝝁≥𝒄,\\displaystyle\\lambda\\,{\\bm{1}}+\\bm{B}^{\\top}\\bm{\\mu}\\geq\\bm{c}, |  | (Dual) |\
|  |  | 𝝁≥0,λ∈ℝ​(free).\\displaystyle\\bm{\\mu}\\geq 0,\\qquad\\lambda\\in\\mathbb{R}\ \\text{(free)}. |  |\
\
The primal is feasible and bounded for every ϵ≥0\\epsilon\\geq 0 (every Nash equilibrium exists ( [Nash, 1950](https://arxiv.org/html/2604.28186v1#bib.bib34 "")) and is a CCE), so by strong duality the primal and dual attain the same optimal value. Importantly, the dual feasible region does not depend on ϵ\\epsilon, and we denote it by 𝒟\\mathcal{D}. Since the dual optimum is finite by strong duality, it is attained at a vertex of 𝒟\\mathcal{D}. Because 𝒟\\mathcal{D}’s vertex set Vertex​(𝒟)\\text{Vertex}(\\mathcal{D}) is finite, we obtain\
\
|     |     |     |\
| --- | --- | --- |\
|  | EWFCCE​(ϵ)=min(λ,𝝁)∈Vertex​(𝒟)⁡λ+ϵ⋅𝟏⊤​𝝁.\\displaystyle{\\rm EWF}^{\\rm CCE}(\\epsilon)=\\min\_{(\\lambda,\\bm{\\mu})\\in\\text{Vertex}(\\mathcal{D})}\\lambda+\\epsilon\\cdot{\\bm{1}}^{\\top}\\bm{\\mu}. |  |\
\
Finally, EWFCCE{\\rm EWF}^{\\rm CCE} is the pointwise minimum of finitely many linear functions of ϵ\\epsilon, and is therefore piecewise linear and concave. ∎\
\
See [9.3](https://arxiv.org/html/2604.28186v1#S9.theoremcounter3 "Lemma 9.3. ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
In the Stag Hunt, the slope can be zero because a social-welfare-maximizing joint strategy is itself a Nash equilibrium. Next, we give an example in which the slope is unbounded.\
\
|     |     |     |\
| --- | --- | --- |\
|  | Confess (C) | Defect (D) |\
| Confess (C) | (0.6,0.6)(0.6,0.6) | (0.2−ζ,1)(0.2-\\zeta,1) |\
| Defect (D) | (1,0.2−ζ)(1,0.2-\\zeta) | (0.2,0.2)(0.2,0.2) |\
\
Table 5: Utility matrix for a variant of Prisoner’s Dilemma, where ζ>0\\zeta>0 is a constant. Each entry (a,b)(a,b) gives the payoff to the row player (aa) and the column player (bb).\
\
Consider the variant of Prisoner’s Dilemma in [Table5](https://arxiv.org/html/2604.28186v1#A10.T5 "In Proof. ‣ Appendix J Omitted Proofs for ‣ Computing Equilibrium beyond Unilateral Deviation"). It is straightforward to verify that the unique CCE remains (D,D)(D,D). Now consider the following strategy141414\
\
\
\
\
\
\
\
In fact, this strategy is not correlated, so [Lemma9.3](https://arxiv.org/html/2604.28186v1#S9.theoremcounter3 "Lemma 9.3. ‣ 9.1 Exploitability Welfare Frontier (EWF) ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") extends to EWFNE{\\rm EWF}^{\\rm NE} and EWFCE{\\rm EWF}^{\\rm CE} as well., which is a linear mixture of the pure strategies (D,D)(D,D) and (C,D)(C,D).\
\
|     |     |     |\
| --- | --- | --- |\
|  | (1−p)⋅(D,D)+p⋅(C,D).\\displaystyle(1-p)\\cdot(D,D)+p\\cdot(C,D). |  |\
\
Its social welfare equals\
\
|     |     |     |\
| --- | --- | --- |\
|  | 0.4​(1−p)+(1.2−ζ)​p=0.4+(0.8−ζ)​p,\\displaystyle 0.4(1-p)+(1.2-\\zeta)p=0.4+(0.8-\\zeta)p, |  |\
\
while its exploitability is ζ⋅p\\zeta\\cdot p. Hence, the slope at ϵ=0\\epsilon=0 is at least\
\
|     |     |     |\
| --- | --- | --- |\
|  | 0.4+(0.8−ζ)​p−0.4ζ⋅p−0.0=0.8−ζζ.\\displaystyle\\frac{0.4+(0.8-\\zeta)p-0.4}{\\zeta\\cdot p-0.0}=\\frac{0.8-\\zeta}{\\zeta}. |  |\
\
Letting ζ→0\\zeta\\to 0 makes this ratio diverge, so the slope can be arbitrarily large. ∎\
\
See [9.5](https://arxiv.org/html/2604.28186v1#S9.theoremcounter5 "Lemma 9.5. ‣ 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
For any ϵ>0\\epsilon>0, let π∗\\pi^{\*} be the strategy that maximizes social welfare subject to its exploitability being at most ϵ\\epsilon. Let g∗=max𝒂^∈𝒜⁡1N​∑i=1N𝔼𝒂∼π∗​\[𝒰i​(𝒂^)−𝒰i​(𝒂)\]g^{\*}=\\max\_{\\widehat{\\bm{a}}\\in\\mathcal{A}}\\frac{1}{N}\\sum\_{i=1}^{N}\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\*}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{\\bm{a}}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] be the maximum gain for the grand coalition \[N\]\[N\]. Let w=g∗ϵ+g∗w=\\frac{g^{\*}}{\\epsilon+g^{\*}}. Then, by construction, the objective value for π∗\\pi^{\*} under [9.3](https://arxiv.org/html/2604.28186v1#S9.E3 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") is:\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  | maxS∈𝒮⁡max𝒂^S∈𝒜S​wS\|S\|​∑i∈S𝔼𝒂∼π∗​\[…\]\\displaystyle\\max\_{S\\in{\\mathcal{S}}}\\max\_{\\widehat{\\bm{a}}\_{S}\\in\\mathcal{A}\_{S}}\\frac{w\_{S}}{\|S\|}\\sum\_{i\\in S}\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\*}}\[\\dots\] | =max⁡(w⋅(exploitability),(1−w)⋅g∗)\\displaystyle=\\max\\left(w\\cdot(\\text{exploitability}),(1-w)\\cdot g^{\*}\\right) |  |\
|  |  | ≤max⁡(w​ϵ,(1−w)​g∗)=ϵ​g∗ϵ+g∗.\\displaystyle\\leq\\max\\left(w\\epsilon,(1-w)g^{\*}\\right)=\\frac{\\epsilon g^{\*}}{\\epsilon+g^{\*}}. |  |\
\
Any strategy π^\\widehat{\\pi} with exploitability >ϵ>\\epsilon would have an objective value >w​ϵ=ϵ​g∗ϵ+g∗>w\\epsilon=\\frac{\\epsilon g^{\*}}{\\epsilon+g^{\*}}, which is worse than the value π∗\\pi^{\*} achieves. Therefore, any optimal solution to [9.3](https://arxiv.org/html/2604.28186v1#S9.E3 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation") must have exploitability at most ϵ\\epsilon. Since π∗\\pi^{\*} by definition maximizes social welfare (i.e., minimizes the coalition gain g∗g^{\*}) among all strategies in this set, it must also be an optimal solution to [9.3](https://arxiv.org/html/2604.28186v1#S9.E3 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation").\
\
Conversely, for any w∈\[0,1)w\\in\[0,1), let π∗\\pi^{\*} be the corresponding strategy that optimizes [9.3](https://arxiv.org/html/2604.28186v1#S9.E3 "In 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation"). Let its exploitability be\
\
|     |     |     |\
| --- | --- | --- |\
|  | ϵ=maxi∈\[N\]⁡maxa^i∈𝒜i​𝔼𝒂∼π∗​\[𝒰i​(a^i,𝒂−i)−𝒰i​(𝒂)\].\\displaystyle\\epsilon=\\max\_{i\\in\[N\]}\\max\_{\\widehat{a}\_{i}\\in\\mathcal{A}\_{i}}\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\*}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{a}\_{i},\\bm{a}\_{-i}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]. |  |\
\
We will show by contradiction that no strategy π′\\pi^{\\prime} exists such that exploitability​(π′)≤ϵ\\text{exploitability}(\\pi^{\\prime})\\leq\\epsilon and S​W​(π′)>S​W​(π∗)SW(\\pi^{\\prime})>SW(\\pi^{\*}) (which implies g′<g∗g^{\\prime}<g^{\*}, where g′g^{\\prime} is the gain for the grand coalition under π′\\pi^{\\prime}).\
\
Suppose such a π′\\pi^{\\prime} exists. We analyze two cases:\
\
#### Case 1: exploitability​(π′)<ϵ\\text{exploitability}(\\pi^{\\prime})<\\epsilon.\
\
Since π′\\pi^{\\prime} has both strictly lower exploitability than π∗\\pi^{\*} and g′<g∗g^{\\prime}<g^{\*} (higher social welfare), its objective value is max⁡(w⋅exploitability​(π′),(1−w)​g′)\\max(w\\cdot\\text{exploitability}(\\pi^{\\prime}),(1-w)g^{\\prime}). This is strictly less than max⁡(w​ϵ,(1−w)​g∗)\\max(w\\epsilon,(1-w)g^{\*}), which is the objective value of π∗\\pi^{\*}. This contradicts the optimality of π∗\\pi^{\*}.\
\
#### Case 2: exploitability​(π′)=ϵ\\text{exploitability}(\\pi^{\\prime})=\\epsilon.\
\
If ϵ>0\\epsilon>0, choose a small δ>0\\delta>0 and consider the mixed strategy πn​e​w=(1−δ)​π′+δ​π′′\\pi\_{new}=(1-\\delta)\\pi^{\\prime}+\\delta\\pi^{\\prime\\prime}, where π′′\\pi^{\\prime\\prime} is an arbitrary CCE, which is guaranteed to exist ( [Nash, 1950](https://arxiv.org/html/2604.28186v1#bib.bib34 "")). For any i∈\[N\]i\\in\[N\] and a^i∈𝒜i\\widehat{a}\_{i}\\in\\mathcal{A}\_{i}, we have:\
\
|     |     |     |     |\
| --- | --- | --- | --- |\
|  |  | 𝔼𝒂∼πn​e​w​\[𝒰i​(a^i,𝒂−i)−𝒰i​(𝒂)\]\\displaystyle\\mathbb{E}\_{\\bm{a}\\sim\\pi\_{new}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{a}\_{i},\\bm{a}\_{-i}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | =\\displaystyle= | (1−δ)​𝔼𝒂∼π′​\[𝒰i​(a^i,𝒂−i)−𝒰i​(𝒂)\]+δ​𝔼𝒂∼π′′​\[𝒰i​(a^i,𝒂−i)−𝒰i​(𝒂)\]\\displaystyle(1-\\delta)\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\\prime}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{a}\_{i},\\bm{a}\_{-i}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\]+\\delta\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\\prime\\prime}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{a}\_{i},\\bm{a}\_{-i}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | ≤(i)\\displaystyle\\overset{(i)}{\\leq} | (1−δ)​𝔼𝒂∼π′​\[𝒰i​(a^i,𝒂−i)−𝒰i​(𝒂)\]\\displaystyle(1-\\delta)\\mathbb{E}\_{\\bm{a}\\sim\\pi^{\\prime}}\\left\[\\mathcal{U}\_{i}\\left(\\widehat{a}\_{i},\\bm{a}\_{-i}\\right)-\\mathcal{U}\_{i}\\left(\\bm{a}\\right)\\right\] |  |\
|  | ≤\\displaystyle\\leq | (1−δ)​ϵ.\\displaystyle(1-\\delta)\\epsilon. |  |\
\
Step (i)(i) holds because π′′\\pi^{\\prime\\prime} is a CCE, so its exploitability 𝔼π′′​\[…\]\\mathbb{E}\_{\\pi^{\\prime\\prime}}\[\\dots\] is ≤0\\leq 0.\
Since ϵ>0\\epsilon>0, the new strategy πn​e​w\\pi\_{new} has exploitability​(πn​e​w)<ϵ\\text{exploitability}(\\pi\_{new})<\\epsilon. By continuity, for sufficiently small δ\\delta, S​W​(πn​e​w)SW(\\pi\_{new}) remains strictly higher than S​W​(π∗)SW(\\pi^{\*}) (since S​W​(π′)>S​W​(π∗)SW(\\pi^{\\prime})>SW(\\pi^{\*})). This puts us in Case 1, which leads to a contradiction.\
\
If ϵ≤0\\epsilon\\leq 0, then exploitability​(π∗)≤0\\text{exploitability}(\\pi^{\*})\\leq 0. The objective value for π∗\\pi^{\*} is max⁡(w​ϵ,(1−w)​g∗)=(1−w)​g∗\\max(w\\epsilon,(1-w)g^{\*})=(1-w)g^{\*} (since w​ϵ≤0w\\epsilon\\leq 0 and (1−w)​g∗≥0(1-w)g^{\*}\\geq 0 by definition). The hypothetical strategy π′\\pi^{\\prime} has exploitability​(π′)=ϵ≤0\\text{exploitability}(\\pi^{\\prime})=\\epsilon\\leq 0 and g′<g∗g^{\\prime}<g^{\*}. Its objective value is max⁡(w​ϵ,(1−w)​g′)=(1−w)​g′\\max(w\\epsilon,(1-w)g^{\\prime})=(1-w)g^{\\prime}. Since g′<g∗g^{\\prime}<g^{\*} and w<1w<1, the objective value of π′\\pi^{\\prime} is strictly less than that of π∗\\pi^{\*}, which contradicts the optimality of π∗\\pi^{\*}.\
\
In all cases, the existence of such a π′\\pi^{\\prime} leads to a contradiction. Thus, π∗\\pi^{\*} must be a solution that maximizes social welfare for a given exploitability ϵ\\epsilon.\
∎\
\
See [9.6](https://arxiv.org/html/2604.28186v1#S9.theoremcounter6 "Lemma 9.6. ‣ 9.2 Finding a Pareto Optimal Strategy ‣ 9 Application: Tradeoff between Exploitability and Social Welfare ‣ Computing Equilibrium beyond Unilateral Deviation")\
\
###### Proof.\
\
The proof follows from Theorem 5.10 of [Papadimitriou and Roughgarden (2008)](https://arxiv.org/html/2604.28186v1#bib.bib37 ""), which shows that for each of the succinct game classes listed above, deciding whether a _dominant outcome_ exists, _i.e._, whether there is a joint strategy at which every player attains that player’s maximum utility, is NP-hard. We reduce this decision problem to computing EWFCCE​(0){\\rm EWF}^{\\rm CCE}(0).\
\
Let M≔∑i=1Nmax𝒂∈𝒜⁡𝒰i​(𝒂)M\\coloneqq\\sum\_{i=1}^{N}\\max\_{\\bm{a}\\in\\mathcal{A}}\\mathcal{U}\_{i}(\\bm{a}). The quantity MM can be computed efficiently in all of the above games ( [Papadimitriou and Roughgarden, 2008](https://arxiv.org/html/2604.28186v1#bib.bib37 "")). If a dominant outcome exists, then the corresponding joint strategy is a CCE, implying EWFCCE​(0)=M{\\rm EWF}^{\\rm CCE}(0)=M. Conversely, if no dominant outcome exists, then no CCE can achieve every player’s maximum utility simultaneously, and thus\
\
|     |     |     |\
| --- | --- | --- |\
|  | EWFCCE​(0)<M.\\displaystyle{\\rm EWF}^{\\rm CCE}(0)<M. |  |\
\
Therefore, computing EWFCCE​(0){\\rm EWF}^{\\rm CCE}(0) decides whether a dominant outcome exists, establishing NP-hardness. ∎

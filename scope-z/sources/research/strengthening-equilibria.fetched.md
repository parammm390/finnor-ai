# strengthening-equilibria

Source: https://arxiv.org/html/2312.14745v2
Fetch status: 200
Retention basis: FetchUrl-rendered Markdown, not original PDF/source bytes.

Title:

Content selection saved. Describe the issue below:

Description:

![](https://arxiv.org/static/base/1.0.1/images/icons/smileybones-small.svg)arXiv is now an independent nonprofit! [Learn more](https://info.arxiv.org/about) ×

[License: CC BY 4.0](https://info.arxiv.org/help/license/index.html#licenses-available)

arXiv:2312.14745v2 \[cs.GT\] 25 Dec 2023

# Strengthening Nash Equilibria

Ivan Geffner
Moshe Tennenholtz
††thanks: The work by Ivan Geffner and Moshe Tennenholtz was supported by funding from
the European Research Council (ERC) under the European Union’s Horizon 2020
research and innovation programme (grant agreement 740435).

###### Abstract

Nash equilibrium is often heralded as a guiding principle for rational decision-making in strategic interactions. However, it is well-known that Nash equilibrium sometimes fails as a reliable predictor of outcomes, with two of the most notable issues being the fact that it is not resilient to collusion and that there may be multiple Nash equilibria in a single game. In this paper, we show that a mechanism designer can get around these two issues for free by expanding the action sets of the original game. More precisely, given a normal-form or Bayesian game Γ\\Gamma and a Nash equilibrium σ→\\vec{\\sigma} in Γ\\Gamma, a mechanism designer can construct a new game Γσ→\\Gamma^{\\vec{\\sigma}} by expanding the action set of each player and defining appropriate utilities in the action profiles that were not already in the original game. We show that the designer can construct Γσ→\\Gamma^{\\vec{\\sigma}} in such a way that (a) σ→\\vec{\\sigma} is a semi-strong Nash equilibrium of Γσ→\\Gamma^{\\vec{\\sigma}}, and (b) σ→\\vec{\\sigma} Pareto-dominates or quasi Pareto-dominates all other Nash equilibria of Γσ→\\Gamma^{\\vec{\\sigma}}.

## 1 Introduction

Suppose that three pirates want to share a treasure consisting of 300300 coins. Each pirate can individually choose if it cooperates or defects. If all three pirates cooperate, they split the treasure equally and each one of them gets 100100 coins. The same happens if only one pirate defects (she cannot overpower the other two), or if all three pirates defect. However, if exactly two pirates defect, they can keep the treasure for themselves and get 150150 coins each while the remaining pirate gets 00. Clearly, all three pirates cooperating is a Nash equilibrium since no pirate gets additional utility by defecting. However, this equilibrium is not resilient to coalitions since two pirates can get additional utility by defecting together. Now, suppose that these three pirates are in an identical situation with the exception that there is an additional action available for them: _Betray_. Betraying works as follows. If the number of pirates that play either _Defect_ or _Betray_ is different than two, nothing happens and all three pirates split the treasure equally. Otherwise, we have the following cases depending on what the two non-cooperative pirates play:

- •


(Defect, Defect): The two defecting pirates get 150150 coins each while the remaining pirate gets 00.

- •


(Betray, Defect): The pirate that betrays kills the pirate that defects and gets all 300300 coins.

- •


(Betray, Betray): Both pirates kill each other. The remaining pirate gets all 300300 coins.


As in the previous game, the strategy profile in which all three pirates cooperate is a Nash equilibrium that is not resilient to collusion. Nevertheless, we can argue that in this scenario it is never in the interest of the pirates to collude. If two pirates decide to play (Defect, Defect), one could easily betray the other in order to get a bigger share. In general, this type of Nash equilibrium is called _semi-strong_\[ [21](https://arxiv.org/html/2312.14745v2#bib.bib21 "")\]. In a semi-strong Nash equilibrium, no coalition can increase the utility of all of its members while simultaneously satisfying that no member of the coalition can further increase its utility by defecting (inside of the coalition).

In the game with three pirates described above, we showed that the addition of the _Betray_ action converted a Nash equilibrium that was vulnerable to coalitions to a semi-strong one. A natural question that follows is if a mechanism designer can make any Nash equilibrium semi-strong by adding appropriate actions and utilities to the original game. In this paper, we give a positive answer to this question. Moreover, in normal-form games or Bayesian games with independent types, we show that we can add actions in such a way that the original equilibrium is not only semi-strong, but also Pareto-dominates all other Nash equilibria of the extended game. In arbitrary Bayesian games, we show that the original equilibrium quasi Pareto-dominates all other equilibria, which means that the total welfare of any subset SS of players with \|S\|≥2\|S\|\\geq 2 is always greater in the original equilibrium. This implies that the mechanism designer can bluff about the existence of these additional actions since they would never be played in practice.

Perhaps not surprisingly, strengthening a pure Nash equilibrium σ→\\vec{\\sigma} is relatively simple. We can do so by simply adding a _report_ action to each player and defining the new utilities in such a way that players that defect from σ→\\vec{\\sigma} while being reported get punished (note that if two players play _report_, they both are defecting while being reported), and players who report defecting players get rewarded. The real difficulty of the problem arises when σ→\\vec{\\sigma} is a mixed strategy, since in this case it is hard to tell if a player ii is defecting or if the action played by ii is a legitimate outcome from randomization. Additional complexity is added when players have (possibly correlated) private information and when the game is infinite (i.e., when the sets of possible actions are infinite). In fact, these cases require carefully calibrated mechanisms, which serve as the main technical contribution of our paper. At a high level, our approach is to allow players to _bet_ or _predict_ what actions or action profiles are going to be played by other players (besides playing an action in the original game). If they guess correctly, they get rewarded and the player whose action was predicted gets punished. If they guess wrong, they get punished. We show that we can calibrate the payoffs of such bets in such a way that, if a coalition defects and they all win, there exists a player in the coalition that has incentives to bet on other members of the coalition or there exists a player in the coalition that has incentives to modify its strategy because of the bets placed by other players.

### 1.1 Related work

The work in this paper intersects with two large branches of the economics and computer science literature. The first one is the study of collusion-resilient protocols in multi-agent systems. Ben-Or \[ [9](https://arxiv.org/html/2312.14745v2#bib.bib9 "")\] and Rabin \[ [22](https://arxiv.org/html/2312.14745v2#bib.bib22 "")\]
provided protocols that implement consensus in the presence of tt byzantine faults if the number of players nn satisfies n>3​tn>3t. These protocols were later generalized by Ben-Or, Goldwasser and Widgerson \[ [8](https://arxiv.org/html/2312.14745v2#bib.bib8 "")\] who showed that, if n>3​tn>3t, we can implement synchronous multiparty secure computation of any function ff on a finite domain in the presence of at most tt byzantine faults. Many subsequent authors added strategic incentives into the mix \[ [1](https://arxiv.org/html/2312.14745v2#bib.bib1 ""), [5](https://arxiv.org/html/2312.14745v2#bib.bib5 ""), [4](https://arxiv.org/html/2312.14745v2#bib.bib4 ""), [16](https://arxiv.org/html/2312.14745v2#bib.bib16 ""), [25](https://arxiv.org/html/2312.14745v2#bib.bib25 ""), [23](https://arxiv.org/html/2312.14745v2#bib.bib23 "")\]. Bernheim, Peleg and Whinston \[ [11](https://arxiv.org/html/2312.14745v2#bib.bib11 "")\] introduced a recursive definition for _coalition-proof equilibrium_. Intuitively, a strategy profile σ→\\vec{\\sigma} is coalition-proof if there is no coalition that can defect from the main strategy to another coalition-proof strategy in such a way that all of its members get a better utility. Penn, Polukarov and Tennenholtz \[ [21](https://arxiv.org/html/2312.14745v2#bib.bib21 "")\] defined _semi-strong Nash equilibrium_ in a similar way, but with only one level of recursion (i.e., for a coalition to succeed, their new strategy must also be a Nash equilibrium). Abraham, Dolev, Gonen and Halpern \[ [3](https://arxiv.org/html/2312.14745v2#bib.bib3 "")\] adapted Aumann’s definition of _kk-resilience_\[ [6](https://arxiv.org/html/2312.14745v2#bib.bib6 "")\] to cheap-talk games, and showed that every synchronous mediator can be implemented by a kk-resilient cheap-talk strategy (i.e., a strategy in which coalitions of at most kk agents do not benefit from defecting from the proposed strategy) if n>2​kn>2k and if there is an appropriate way to punish defecting players. Most of these results have been generalized to the asynchronous setting as well \[ [12](https://arxiv.org/html/2312.14745v2#bib.bib12 ""), [13](https://arxiv.org/html/2312.14745v2#bib.bib13 ""), [10](https://arxiv.org/html/2312.14745v2#bib.bib10 ""), [17](https://arxiv.org/html/2312.14745v2#bib.bib17 ""), [15](https://arxiv.org/html/2312.14745v2#bib.bib15 "")\]. In particular, Abraham, Dolev, Geffner and Halpern \[ [2](https://arxiv.org/html/2312.14745v2#bib.bib2 "")\] provided a kk-resilient implementation of asynchronous mediators if n>3​kn>3k and there exists a punishment strategy. Although most of the results in this area require that the ratio between the number of players nn and the maximum size tt or kk of the defecting coalition satisfies a certain threshold, our results show that, if we only need semi-strongness, we can take the protocol used for t=1t=1 or k=1k=1 and expand the set of actions in such a way that the same protocol tolerates deviations of coalitions of arbitrary size (according to the semi-strong definition). For example, this means that if a mechanism designer can modify (or can bluff about modifying) the action sets of the players, we provide a way to design semi-strong protocols that implement mediators in synchronous or asynchronous systems that require only three or four players, respectively.

The second closely related branch is mechanism design. The aim of a mechanism designer
is to design the set of strategies of the players and to define the utilities that they would get by following said strategies in order to influence the outcomes obtained from rational play.
Sometimes, this influence can be exerted with the inclusion of a third-party mediator that may interfere with the game in different ways.
Aumann\[ [7](https://arxiv.org/html/2312.14745v2#bib.bib7 "")\] considered the inclusion of a cheap-talk mediator in normal-form and Bayesian games. More precisely, given a normal-form game Γ\\Gamma, Aumann constructed a game Γd\\Gamma\_{d} where players can communicate via cheap-talk with a mediator dd before playing an action in Γ\\Gamma. The Nash equilibria of the resulting games were defined as correlated equilibria. Forges \[ [14](https://arxiv.org/html/2312.14745v2#bib.bib14 "")\] considered the same extension in Bayesian games and gave a geometric characterization of the resulting equilibria, which were labelled as _communication equilibria_. Monderer and Tennenholtz \[ [19](https://arxiv.org/html/2312.14745v2#bib.bib19 "")\] showed that we can guarantee the existence of strong Nash equilibria in games with several classes of mediators. In their setting, some of these mediators can go beyond sending messages or signals to the players, such as for instance playing on their behalf when permitted. In another paper, Monderer and Tennenholtz \[ [18](https://arxiv.org/html/2312.14745v2#bib.bib18 "")\] considered a setting where the mediator has the power to _promise payments_ to the players (i.e., to increase their utility on given outcomes) but cannot communicate. They study the minimum payment that is necessary to influence the behavior of the players. Monderer and Tennenholtz showed that, given any normal-form game Γ\\Gamma and any pure Nash equilibrium σ→\\vec{\\sigma} in Γ\\Gamma, there exists a mediator dd that promises payments only outside of the equilibrium path in such a way that σ→\\vec{\\sigma} is not only a Nash equilibrium but also a dominant strategy in the newly generated game. Tennenholtz \[ [24](https://arxiv.org/html/2312.14745v2#bib.bib24 "")\] later considered a type of normal-form games where players are programs and a third-party mediator is able to access and reveal the source code of other players before they commit to an action. Tennenholtz showed that the set of Nash equilibria in this setting (or _program equilibria_, as defined in \[ [24](https://arxiv.org/html/2312.14745v2#bib.bib24 "")\]) is richer than without the inclusion of the mediator. For example, there exist program equilibria in the one-shot Prisoner’s Dilemma where both players cooperate. Oesterheld et al. \[ [20](https://arxiv.org/html/2312.14745v2#bib.bib20 "")\] refined this idea and defined _similarity-based coopaeration_, where each player only has access to a similarity parameter instead of the whole source code of other players. They showed that, in their setting, there also exist equilibria in which both players cooperate in the Prisoner’s Dilemma. Our setting can also be viewed as including a mediator into a normal-form or Bayesian game in order to influence the outcome. In this case, the mediator cannot communicate with the players but can extend the game by adding new actions with arbitrary utilities.

### 1.2 Paper Structure

The rest of the paper is structured as follows. In Section [2](https://arxiv.org/html/2312.14745v2#S2 "2 Basic definitions ‣ Strengthening Nash Equilibria") we give the necessary definitions to formalize and prove our main results, which are stated in Section [3](https://arxiv.org/html/2312.14745v2#S3 "3 Main Results ‣ Strengthening Nash Equilibria"). Section [4](https://arxiv.org/html/2312.14745v2#S4 "4 Sketch of the Proofs ‣ Strengthening Nash Equilibria") provides a high-level overview of the proofs, along with several examples that showcase the main difficulties that are needed to overcome in each setting. We give a formal proof of our main results in Sections [5](https://arxiv.org/html/2312.14745v2#S5 "5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") and [6](https://arxiv.org/html/2312.14745v2#S6 "6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria"). The first of these sections deals with the case of finite normal-form games and finite Bayesian games with independent types, and the latter deals with (arbitrary) finite Bayesian games. These proofs are generalized in Section [7](https://arxiv.org/html/2312.14745v2#S7 "7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") in order to hold for games with infinite actions as well. We give a conclusion in Section [8](https://arxiv.org/html/2312.14745v2#S8 "8 Conclusion and Open Problems ‣ Strengthening Nash Equilibria"), along with a brief summary about the remaining open problems.

## 2 Basic definitions

### 2.1 Games and Equilibria

A normal-form game is a tuple (P,A,U)(P,A,U) where P={1,2,…,n}P=\\{1,2,\\ldots,n\\} is the set of players, A:=A1×A2×…×AnA:=A\_{1}\\times A\_{2}\\times\\ldots\\times A\_{n} is the set of possible actions profiles and U=(u1,u2,…,un)U=(u\_{1},u\_{2},\\ldots,u\_{n}) is a tuple of utility functions such that ui:A×ℝu\_{i}:A\\times\\mathbb{R} outputs the utility of player ii given the action profile played. In a normal form game, a (mixed) strategy σi\\sigma\_{i} for player ii is simply a distribution of actions of AiA\_{i} (we denote by Δ​Ai\\Delta A\_{i} the set of such possible distributions). A strategy profile σ→=(σ1,…,σn)\\vec{\\sigma}=(\\sigma\_{1},\\ldots,\\sigma\_{n}) is a Nash Equilibrium of Γ\\Gamma if no player can increase its utility by switching to another strategy. More precisely, σ→\\vec{\\sigma} is a Nash equilibrium if ui​(σ→)≥ui​(σ→−i,τi)u\_{i}(\\vec{\\sigma})\\geq u\_{i}(\\vec{\\sigma}\_{-i},\\tau\_{i}) for all players ii and all strategies τi\\tau\_{i} for ii (where σ→−i\\vec{\\sigma}\_{-i} denotes that all players but ii play their part of strategy profile σ→\\vec{\\sigma}).

A Bayesian game is a generalization of normal-form games where players have private types and the utility of each player depends not only on the action profile played but also on its own type. More formally, a Bayesian game is a tuple (P,T,q,A,U)(P,T,q,A,U) where T=T1×T2×…×TnT=T\_{1}\\times T\_{2}\\times\\ldots\\times T\_{n} is the set of possible type profiles and qq is the prior distribution over TT that is common knowledge among the players. PP, AA and UU denote the same concepts as in normal-form games, except that the domain of each utility function uiu\_{i} is Ti×AT\_{i}\\times A instead of just AA. In Bayesian games, strategies are functions from types to distributions over action profiles. More precisely, in a Bayesian game Γ=(P,T,q,A,U)\\Gamma=(P,T,q,A,U), a strategy σi\\sigma\_{i} for player ii maps elements from TiT\_{i} to distributions over AA. As in normal-form games, a strategy profile σ→\\vec{\\sigma} is a Nash equilibrium if ui​(σ→)≥ui​(σ→−i,τi)u\_{i}(\\vec{\\sigma})\\geq u\_{i}(\\vec{\\sigma}\_{-i},\\tau\_{i}) for all players ii and all strategies τi\\tau\_{i} for ii. For simplicity, we will assume that no player has a type that has 00 probability of being sampled.

Given a normal-form or Bayesian game Γ\\Gamma, we say that Γ\\Gamma is _finite_ if the set of actions is finite, and we say that Γ\\Gamma is _bounded_ if all utility functions are bounded. Note that if a game is finite, it is also bounded.

### 2.2 Resilience to coalitions

There are well-known notions of equilibria that are resilient to collusion and joint deviations. The first of such notions is _strong Nash equilibrium_\[ [6](https://arxiv.org/html/2312.14745v2#bib.bib6 "")\], which occurs if no possible coalition can strictly increase the payoff of all its members by jointly deviating. More precisely, in a normal-form or Bayesian game Γ=(P,T,q,A,U)\\Gamma=(P,T,q,A,U), a strategy profile σ→\\vec{\\sigma} is a strong Nash equilibrium if, for all subsets S⊆PS\\subseteq P and all strategy profiles τ→S\\vec{\\tau}\_{S} for players in SS, there exists a player i∈Si\\in S such that ui​(σ→)≥ui​(σ→−S,τ→S)u\_{i}(\\vec{\\sigma})\\geq u\_{i}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}).

In this paper we focus on a variant of strong Nash equilibrium introduced by Penn, Polukarov and Tennenholtz \[ [21](https://arxiv.org/html/2312.14745v2#bib.bib21 "")\] in which, for a joint deviation to be successful, not only all members must strictly benefit from colluding, but also the strategy performed by the members of the coalition must be a Nash equilibrium inside of the larger game (in which the players outside of the coalition simply play their part of σ→\\vec{\\sigma}). The following definition makes this precise.

###### Definition 1.

Let Γ\\Gamma be a normal-form or a Bayesian game
and σ→\\vec{\\sigma} be a strategy profile for Γ\\Gamma. Then, σ→\\vec{\\sigma} is a semi-strong Nash equilibrium if, for all subsets SS and all strategy profiles τ→S\\vec{\\tau}\_{S} for SS, there exists a player i∈Si\\in S and a strategy τi′\\tau^{\\prime}\_{i} for ii such that

|     |     |     |
| --- | --- | --- |
|  | ui​(σ→)≥ui​(σ→−S,τ→S)orui​(σ→−S,τ→S∖{i},τi′)>ui​(σ→−S,τ→S)u\_{i}(\\vec{\\sigma})\\geq u\_{i}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\quad\\mbox{or}\\quad u\_{i}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i})>u\_{i}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}) |  |

Note that if the first condition is satisfied for some ii, then τ→S\\vec{\\tau}\_{S} is not profitable for ii, while the second condition implies that ii can further deviate from τ→S\\vec{\\tau}\_{S} to increase its utility from the one it would get in the coalition.

### 2.3 Game extensions

The results of this paper involve games that result from extending the set of actions of simpler games. We say that a Bayesian game Γ′=(P′,T′,q′,A′,U′)\\Gamma^{\\prime}=(P^{\\prime},T^{\\prime},q^{\\prime},A^{\\prime},U^{\\prime}) _extends_ another Bayesian game Γ=(P,T,q,A,U)\\Gamma=(P,T,q,A,U) if P′=PP^{\\prime}=P, T′=TT^{\\prime}=T, q′=qq^{\\prime}=q, Ai⊆Ai′A\_{i}\\subseteq A^{\\prime}\_{i} for all i∈Pi\\in P, and ui​(a→)=ui′​(a→)u\_{i}(\\vec{a})=u^{\\prime}\_{i}(\\vec{a}) for all a→∈A\\vec{a}\\in A and i∈Pi\\in P. Intuitively, game extensions must have the same players, action profiles, and utilities as the original game, but they may also include additional actions for the players that may give arbitrary utilities when played. The definition for normal-form games is analogous.

For future reference, note that if Γ′\\Gamma^{\\prime} extends Γ\\Gamma, we can view strategy profiles of Γ\\Gamma as strategy profiles in Γ′\\Gamma^{\\prime} in a natural way: each player ii plays each action in AiA\_{i} with the same probability as in Γ\\Gamma, and plays each action in Ai′∖AiA^{\\prime}\_{i}\\setminus A\_{i} with probability 00. Unless it is specified, for the rest of the paper we will always use such convention.

### 2.4 Comparing Nash Equilibria

Given a Bayesian or Normal-form game Γ\\Gamma and two Nash equilibria σ→\\vec{\\sigma} and τ→\\vec{\\tau}, we say that σ→\\vec{\\sigma} _Pareto-dominates_ τ→\\vec{\\tau} if ui​(σ→)≥ui​(τ→)u\_{i}(\\vec{\\sigma})\\geq u\_{i}(\\vec{\\tau}) for all i∈Pi\\in P. Moreover, we say that σ→\\vec{\\sigma} _quasi Pareto-dominates_ τ→\\vec{\\tau} if, for all subsets S⊆PS\\subseteq P with \|S\|≥2\|S\|\\geq 2,

|     |     |     |
| --- | --- | --- |
|  | ∑i∈Sui​(σ→)≥∑i∈Sui​(τ→).\\sum\_{i\\in S}u\_{i}(\\vec{\\sigma})\\geq\\sum\_{i\\in S}u\_{i}(\\vec{\\tau}). |  |

Note that, if \|P\|≥2\|P\|\\geq 2 and σ→\\vec{\\sigma} quasi Pareto-dominates τ→\\vec{\\tau},

- •


At most one player ii satisfies ui​(τ→)>ui​(σ→)u\_{i}(\\vec{\\tau})>u\_{i}(\\vec{\\sigma}).

- •


The total welfare of the players is greater with σ→\\vec{\\sigma} than with τ→\\vec{\\tau}.


## 3 Main Results

The main contribution of this paper can be summarized by the following Theorems.

###### Theorem 1.

Let Γ=(P,T,q,A,U)\\Gamma=(P,T,q,A,U) be a bounded Bayesian game with independent types (i.e., that qq samples the types independently).
Then, for each Nash equilibrium σ→\\vec{\\sigma} of Γ\\Gamma there exists an extension
Γσ→=(P,T,q,Aσ→,Uσ→)\\Gamma^{\\vec{\\sigma}}=(P,T,q,A^{\\vec{\\sigma}},U^{\\vec{\\sigma}})
of Γ\\Gamma such that:

- (a)


σ→\\vec{\\sigma} is a semi-strong Nash equilibrium of Γσ→\\Gamma^{\\vec{\\sigma}}.

- (b)


σ→\\vec{\\sigma} Pareto-dominates all other Nash equilibria of Γσ→\\Gamma^{\\vec{\\sigma}}.


Moreover, if AA is finite, Aσ→A^{\\vec{\\sigma}} satisfies that \|Aiσ→\|≤\|Ai\|⋅\|P\|⋅\|A\|m​a​x\|A^{\\vec{\\sigma}}\_{i}\|\\leq\|A\_{i}\|\\cdot\|P\|\\cdot\|A\|\_{max} for all i∈Pi\\in P, where \|A\|m​a​x=maxi∈P⁡\|Ai\|\|A\|\_{max}=\\max\_{i\\in P}{\|A\_{i}\|}.

Intuitively, part (a) of Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") states that given any game and any Nash equilibrium, we can expand the game such that the original Nash equilibrium becomes semi-strong. At the same time, part (b) implies that none of the newly added actions will ever be played if all players play optimally. The last part of the Theorem states that, if Γ\\Gamma is finite, then the size of the resulting extension is polynomial over the size of Γ\\Gamma. The following Theorem extends Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") to arbitrary Bayesian games.

###### Theorem 2.

Let Γ=(P,T,q,A,U)\\Gamma=(P,T,q,A,U) be a bounded Bayesian game.
Then, for each Nash equilibrium σ→\\vec{\\sigma} of Γ\\Gamma there exists an extension
Γσ→=(P,T,q,Aσ→,Uσ→)\\Gamma^{\\vec{\\sigma}}=(P,T,q,A^{\\vec{\\sigma}},U^{\\vec{\\sigma}})
of Γ\\Gamma such that:

- (a)


σ→\\vec{\\sigma} is a semi-strong Nash equilibrium of Γσ→\\Gamma^{\\vec{\\sigma}}.

- (b)


σ→\\vec{\\sigma} quasi Pareto-dominates all other Nash equilibria of Γσ→\\Gamma^{\\vec{\\sigma}}.


Moreover, if AA is finite, Aσ→A^{\\vec{\\sigma}} satisfies that \|Aiσ→\|=\|Ai\|+\|A\|\|A^{\\vec{\\sigma}}\_{i}\|=\|A\_{i}\|+\|A\| for all i∈Pi\\in P.

The only two differences between Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and Theorem [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") are the size of the extension and the fact that, in Theorem [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria"), the resulting equilibrium quasi Pareto-dominates all other Nash equilibria of Γσ→\\Gamma^{\\vec{\\sigma}} instead of Pareto-dominating.
Note that Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and Theorem [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") do not require that Γ\\Gamma is finite. In fact, as shown in Section [7](https://arxiv.org/html/2312.14745v2#S7 "7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"), the statements still hold when the action sets are uncountable, as long as Γ\\Gamma is bounded.

## 4 Sketch of the Proofs

As in the _three pirates_ example from the introduction, the idea behind
the construction of Γσ=(P,Aσ→,Uσ→)\\Gamma^{\\sigma}=(P,A^{\\vec{\\sigma}},U^{\\vec{\\sigma}}) is that players can play special actions that reward them if another player goes off the equilibrium path. This construction can be very simple for pure Nash equilibria: suppose that σ→\\vec{\\sigma} is a pure Nash equilibrium where each player ii plays some action aia\_{i} with probability 1. Then, we can set Aiσ→=Ai∪{α}A^{\\vec{\\sigma}}\_{i}=A\_{i}\\cup\\{\\alpha\\} and define the payoffs as follows when some player ii plays α\\alpha:

- •


If another player jj plays α\\alpha, all players kk that didn’t play aka\_{k} get m−1m-1 utility (including those who played α\\alpha), where mm is the minimum utility of the game. All other players get the same utility as in equilibrium.

- •


If no other player plays α\\alpha,



  - –


    If all other players jj play aja\_{j}, they all get the same utility as in equilibrium and ii gets m−1m-1.

  - –


    Otherwise, ii gets the maximum possible utility plus 11, all players jj that played aja\_{j} get the same utility as in equilibrium, and all other players get m−1m-1.


It is straightforward to check that Γσ→\\Gamma^{\\vec{\\sigma}} satisfies the conditions of Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria"): First, no player can increase its utility by defecting from σ→\\vec{\\sigma}. Second, if a coalition defects from σ→\\vec{\\sigma} and they all increase their utility, it means that none of them is playing α\\alpha. However, this implies that a player can further increase its utility by switching its action to α\\alpha. Lastly, an analogous reasoning shows that σ→\\vec{\\sigma} is Pareto-optimal: if another strategy profile τ→\\vec{\\tau} gives a better utility than σ→\\vec{\\sigma} to all players, it means that none of them is playing α\\alpha. Then, again, this would not be a Nash equilibrium since a player can increase its utility by playing α\\alpha instead.

If we consider mixed Nash equilibria, the construction becomes more complicated. For instance, there could be Nash equilibria where all actions have non-zero chance of being played, as in the following example.

###### Example 1.

Consider a normal-form game Γ=(P,A,U)\\Gamma=(P,A,U) with P={1,2,…,n}P=\\{1,2,\\ldots,n\\}, Ai={0,1}A\_{i}=\\{0,1\\} for all i∈Pi\\in P, and such that

|     |     |     |
| --- | --- | --- |
|  | ui​(a1,…,an)={1if ​#​ai​(a1,…,an)≥#⁡(1−ai)​(a1,…,an)0otherwise,u\_{i}(a\_{1},\\ldots,a\_{n})=\\left\\{\\begin{array}\[\]{ll}1&\\mbox{if }\\#a\_{i}(a\_{1},\\ldots,a\_{n})\\geq\\#(1-a\_{i})(a\_{1},\\ldots,a\_{n})\\\<br>0&\\mbox{otherwise,}\\end{array}\\right. |  |

where #​ai​(a1,…,an)\\#a\_{i}(a\_{1},\\ldots,a\_{n}) denotes the number of players who played action aia\_{i}. Denote by σ→\\vec{\\sigma} the strategy profile in which each player chooses its action uniformly at random.

Intuitively, ii gets 11 utility if its action is played by the majority of the players and ii gets 00 utility otherwise. Clearly, if all other players randomize their action, it doesn’t matter what action ii chooses since both give the same utility in expectation. Therefore, randomizing its own action is also a best response for ii, which means that σ→\\vec{\\sigma} is a Nash equilibrium. However, σ→\\vec{\\sigma} is not semi-strong: if two or more players collude, it is in their interest to vote on the same value. For instance, all of them playing 00 or all of them playing 11 strictly increases their expected utility and no agent in the coalition can further increase it by playing anything else.

In order to create an extension of Γ\\Gamma such that σ→\\vec{\\sigma} is a semi-strong Nash equilibrium we need a different approach than the one given for pure Nash equilibria. The main issue is that it is not easy to tell if a player ii is defecting from the proposed strategy or not since, regardless of what ii plays, its action could be the result of playing σi\\sigma\_{i}. They key idea is that, in equilibrium, ii must play 00 and 11 with 12\\frac{1}{2} probability each. By contrast, if ii defects, one of these actions must be played with probability greater than 12\\frac{1}{2}. We can make use of this fact as follows. Suppose that, for each player ii and each action ai∈{0,1}a\_{i}\\in\\{0,1\\}, we give each player jj the possibility of _betting_ that ii will play aia\_{i}. If ii plays aia\_{i}, then jj gets xx utility and ii loses x′x^{\\prime} utility. Otherwise, jj gets −x-x utility. Clearly, if ii follows σi{\\sigma}\_{i}, there is no incentive for jj to place such a bet. However, if ii defects, betting on one of ii’s actions gives jj a strictly positive expected utility. We can adjust the values of xx and x′x^{\\prime} such that it is never in the interest of ii to collude and defect. The construction given in Section [5.1](https://arxiv.org/html/2312.14745v2#S5.SS1 "5.1 Construction of Γ^𝜎 ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") follows a similar approach, except for the fact that the utility won by winning a bet and the utility lost by losing a bet may be different. More precisely, the bets are calibrated in such a way that, if ii plays some action aa with the same probability as in σi\\sigma\_{i}, the expected payoff of betting on (i,a)(i,a) is 00, while if ii plays aa with more probability than in σi\\sigma\_{i} the expected payoff of betting on (i,a)(i,a) is strictly positive.

The construction of Γσ→\\Gamma^{\\vec{\\sigma}} for Bayesian games is more complicated. The main issue is that, in normal-form games, whenever a player ii defects from σi\\sigma\_{i} to a different strategy τi\\tau\_{i}, it is guaranteed that there exists an action that is more likely to be played with τi\\tau\_{i} than with σi\\sigma\_{i}. However, this is not true for Bayesian games. For example, consider a game such that Ti=Ai={0,1}T\_{i}=A\_{i}=\\{0,1\\} for all players ii, and such that all types are sampled independently and uniformly from {0,1}\\{0,1\\}. If σi\\sigma\_{i} is the strategy in which player ii plays whatever its type is and τi\\tau\_{i} is the strategy in which it plays the opposite of its type, it is indistinguishable to the other players if ii is playing σi\\sigma\_{i} or if ii is playing τi\\tau\_{i}. In particular, we cannot design bets that give a strictly positive expected utility when ii plays τi\\tau\_{i} and simultaneously give 00 expected utility when ii plays σi\\sigma\_{i}. The key observation is that, if τ→S\\vec{\\tau}\_{S} is a profitable deviation for some coalition SS and types are independent, each player i∈Si\\in S must be able to tell the strategy τj\\tau\_{j} of at least one other player j∈Sj\\in S. Otherwise, ii would get the same utility in (σ→−i,τi)(\\vec{\\sigma}\_{-i},\\tau\_{i}) (see Proposition [4](https://arxiv.org/html/2312.14745v2#Thmproposition4 "Proposition 4. ‣ 5.3 Generalization to Finite Bayesian Games with Independent Types ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria")). This observation implies that the construction used for normal-form games can be easily generalized to also cover Bayesian games with independent types.

Unfortunately, the construction used for normal-form games does not quite work in general for Bayesian games, as the following example shows.

###### Example 2.

Consider a Bayesian game Γ=(P,T,q,A,U)\\Gamma=(P,T,q,A,U) such that P={1,2,3}P=\\{1,2,3\\}, Ti=Ai={0,1}T\_{i}=A\_{i}=\\{0,1\\} for all i∈Pi\\in P, and qq is the uniform distribution over the subset of TT such that the sum of coordinates is odd (i.e., {(t1,t2,t3)∈T∣t1+t2+t3≡1mod2}\\{(t\_{1},t\_{2},t\_{3})\\in T\\mid t\_{1}+t\_{2}+t\_{3}\\equiv 1\\bmod 2\\}). Given an action profile (a1,a2,a3)(a\_{1},a\_{2},a\_{3}), all players get 11 utility if a1+a2+a3a\_{1}+a\_{2}+a\_{3} is odd. Otherwise, they all get 00 utility.

Consider two strategy profiles σ→\\vec{\\sigma} and τ→\\vec{\\tau}. In σ→\\vec{\\sigma}, each player independently plays 00 and 11 with equal probability. In τ→\\vec{\\tau}, each player plays its own type.

In Example [2](https://arxiv.org/html/2312.14745v2#Thmexample2 "Example 2. ‣ 4 Sketch of the Proofs ‣ Strengthening Nash Equilibria"), it is straightforward to check that σ→\\vec{\\sigma} and τ→\\vec{\\tau} are both Nash equilibria where each player plays 00 and 11 with equal probability. However, players get 1/21/2 expected utility with σ→\\vec{\\sigma} and 11 expected utility with τ→\\vec{\\tau}. The main difference between the strategy profiles is that, even though each player has 1/21/2 chance of having type 00 and 1/21/2 chance of having type 11, their types are correlated in such a way that their sum is always an odd number. Moreover, we can easily check that players’ types are pairwise independent. This means that the probability that a player ii plays a certain action a∈{0,1}a\\in\\{0,1\\} with τi\\tau\_{i} is exactly the same as the probability that ii plays aa with σi\\sigma\_{i}, even if we condition the probability on another player jj’s type. Therefore, jj cannot guess ii’s action with τ→\\vec{\\tau} any better than with σ→\\vec{\\sigma}, which implies that the construction used for normal-form games fails in this case.

In order to deal with situations as the one presented in Example [2](https://arxiv.org/html/2312.14745v2#Thmexample2 "Example 2. ‣ 4 Sketch of the Proofs ‣ Strengthening Nash Equilibria"), we modify the construction Γσ→\\Gamma^{\\vec{\\sigma}} used for normal form games in such a way that players can bet on action profiles played by other players instead of individual actions. It can be shown that if bets are calibrated in a similar fashion, Γσ→\\Gamma^{\\vec{\\sigma}} satisfies the properties of Theorem [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria").

To extend the proofs of Theorems [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") to infinite games, we need a slightly different construction, as shown by the following example.

###### Example 3.

Consider a normal-form game Γ=(P,A,U)\\Gamma=(P,A,U) with P={1,2}P=\\{1,2\\}, A1=A2=ℕA\_{1}=A\_{2}=\\mathbb{N}, and

|     |     |     |
| --- | --- | --- |
|  | u1​(a1,a2)=u2​(a1,a2)={0 if ​a1=0​ or ​a2=01 otherwise.u\_{1}(a\_{1},a\_{2})=u\_{2}(a\_{1},a\_{2})=\\left\\{\\begin{array}\[\]{ll}0&\\mbox{ if }a\_{1}=0\\mbox{ or }a\_{2}=0\\\<br>1&\\mbox{ otherwise.}\\end{array}\\right. |  |

Denote by σ→\\vec{\\sigma} the strategy profile in which each player plays 00 with probability 1, and by (τ→)N(\\vec{\\tau})\_{N} the strategy profile in which both players sample their action uniformly at random from {1,2,…,N}\\{1,2,\\ldots,N\\}.

It is easy to check that σ→\\vec{\\sigma} and (τ→)N(\\vec{\\tau})\_{N} are Nash equilibria of Γ\\Gamma. Suppose that we construct Γσ→\\Gamma^{\\vec{\\sigma}} in the same way as in normal-form games and have each player lose CC utility whenever the other player guesses its action correctly. By playing σ→\\vec{\\sigma}, each player gets 00 expected utility. However, if they play (τ→)N(\\vec{\\tau})\_{N}, each player has at most 1/N1/N chance of guessing the other player’s action correctly. Therefore, regardless of how they place their bets, each player can get at least 1−CN1-\\frac{C}{N} expected utility in Γσ→\\Gamma^{\\vec{\\sigma}}. If NN is large enough, this value is larger than the utility that they would get with σ→\\vec{\\sigma}.

The main issue presented in Example [3](https://arxiv.org/html/2312.14745v2#Thmexample3 "Example 3. ‣ 4 Sketch of the Proofs ‣ Strengthening Nash Equilibria") is that players can spread their actions really thin, avoiding this way being caught by other players. Even though this doesn’t always lead to a better equilibrium (e.g., it may happen that no matter how player ii spreads her actions, it is always better for ii to spread them even thinner), this situation is clearly non-desirable. In order to avoid it, the construction in Section [7](https://arxiv.org/html/2312.14745v2#S7 "7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") allows players to bet on arbitrary sets of actions (or arbitrary sets of action profiles when dealing with Bayesian games) instead of just individual actions. Again, these bets are calibrated in such a way that no player benefits from betting if all other players play their part of σ→\\vec{\\sigma}. However, if a player ii defects from σ→\\vec{\\sigma}, betting on the set of actions that ii is more likely to play after defecting always gives a strictly positive payoff. It can be shown that the rewards and punishments from betting can be calibrated in such a way that it is always better to follow the proposed equilibrium σ→\\vec{\\sigma}.

## 5 Proof of Theorem [1](https://arxiv.org/html/2312.14745v2\#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") for Finite Games

In this section we prove Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") for the case in which Γ\\Gamma is finite. We extend this proof for infinite games in Section [7](https://arxiv.org/html/2312.14745v2#S7 "7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria").

In the following sections, we prove Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") for finite normal-form games. Later, in Section [5.3](https://arxiv.org/html/2312.14745v2#S5.SS3 "5.3 Generalization to Finite Bayesian Games with Independent Types ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), we extend the proof to Bayesian games with independent types.

### 5.1 Construction of Γσ\\Gamma^{\\sigma}

In this section we give the precise construction of Γσ→\\Gamma^{\\vec{\\sigma}}. Define

|     |     |     |
| --- | --- | --- |
|  | Aiσ→:=Ai∪(Ai×⋃j∈P({j}×Aj)).A\_{i}^{\\vec{\\sigma}}:=A\_{i}\\cup\\left(A\_{i}\\times\\bigcup\_{j\\in P}\\left(\\{j\\}\\times A\_{j}\\right)\\right). |  |

Elements of Aiσ→A\_{i}^{\\vec{\\sigma}} are either actions of AiA\_{i} or a tuple (ai,j,aj)(a\_{i},j,a\_{j}) that indicates that ii is playing action aia\_{i} but is also betting that player jj is playing action aja\_{j}. Suppose that players play actions (a1,b1),(a2,b2),…,(an,bn)(a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n}) where, for convenience, we use the notation bi:=⊥b\_{i}:=\\bot to denote that player ii placed no bet (i.e., if ii played an action in AiA\_{i}). The utility uiσ→u^{\\vec{\\sigma}}\_{i} of player ii is given by

|     |     |     |
| --- | --- | --- |
|  | uiσ→​((a1,b1),(a2,b2),…,(an,bn)):⁣=ui​(a1,a2,…,an)+wiσ→​((a1,b1),(a2,b2),…,(an,bn))+ℓiσ→​((a1,b1),(a2,b2),…,(an,bn)),\\begin{array}\[\]{lll}u^{\\vec{\\sigma}}\_{i}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n}))&:=&u\_{i}(a\_{1},a\_{2},\\ldots,a\_{n})\\\<br>&+&w\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n}))\\\<br>&+&\\ell\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})),\\end{array} |  |

where wiw\_{i} is the additional utility that ii gets by placing a bet on another player’s action, and ℓi\\ell\_{i} is the additional (negative) utility that ii gets if another player bets on ii’s action and wins. If p(j,aj)σ→p\_{(j,a\_{j})}^{\\vec{\\sigma}} is the probability that strategy σj\\sigma\_{j} assigns to action aja\_{j}, then

|     |     |     |
| --- | --- | --- |
|  | wiσ→​((a1,b1),(a2,b2),…,(an,bn)):={0if bi=⊥1−p(j,aj)σ→if ​bi​ is of the form ​(j,aj)−p(j,aj)σ→if ​bi​ is of the form ​(j,a)​ with ​a≠aj.w\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})):=\\left\\{\\begin{array}\[\]{ll}0&\\mbox{if }b\_{i}=\\bot\\\<br>1-p\_{(j,a\_{j})}^{\\vec{\\sigma}}&\\mbox{if }b\_{i}\\mbox{ is of the form }(j,a\_{j})\\\<br>-p\_{(j,a\_{j})}^{\\vec{\\sigma}}&\\mbox{if }b\_{i}\\mbox{ is of the form }(j,a)\\mbox{ with }a\\not=a\_{j}.\\\<br>\\end{array}\\right. |  |

It is important to note that, if jj does not defect and ii bets on aja\_{j}, then its expected additional utility is given by p(j,aj)σ→​(1−p(j,aj)σ→)+(1−p(j,aj)σ→)​(−p(j,aj)σ→)=0p\_{(j,a\_{j})}^{\\vec{\\sigma}}\\left(1-p\_{(j,a\_{j})}^{\\vec{\\sigma}}\\right)+\\left(1-p\_{(j,a\_{j})}^{\\vec{\\sigma}}\\right)\\left(-p\_{(j,a\_{j})}^{\\vec{\\sigma}}\\right)=0.

Finally, we define ℓiσ→:=∑j∈Pℓ(i,j)σ→\\ell\_{i}^{\\vec{\\sigma}}:=\\sum\_{j\\in P}\\ell\_{(i,j)}^{\\vec{\\sigma}}, where

|     |     |     |
| --- | --- | --- |
|  | ℓ(i,j)σ→​((a1,b1),(a2,b2),…,(an,bn)):={0if ​bj=⊥ or ​bj​ is of the form ​(i,a)​ with ​a≠ai−Cotherwise.\\ell\_{(i,j)}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})):=\\left\\{\\begin{array}\[\]{ll}0&\\mbox{if }b\_{j}=\\bot\\mbox{ or }b\_{j}\\mbox{ is of the form }(i,a)\\mbox{ with }a\\not=a\_{i}\\\<br>-C&\\mbox{otherwise.}\\end{array}\\right. |  |

The constant CC used in the previous definition is simply a large value that serves as a deterrent for players to defect from σ→\\vec{\\sigma}: if a player ii follows a different strategy τi\\tau\_{i}, then there exists some action a∈Aia\\in A\_{i} such that aa is played with strictly more probability in τi\\tau\_{i} than in σi\\sigma\_{i}. If this is the case, because of the way in which we defined wjw\_{j}, it is in the interest of other players jj to bet on (i,ai)(i,a\_{i}), which decreases ii’s overall utility. In Section [5.2](https://arxiv.org/html/2312.14745v2#S5.SS2 "5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), we show that we can choose a value for CC so that conditions (a) and (b) of Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") are satisfied.

### 5.2 Proof of Correctness

#### 5.2.1 Part (a)

We start by showing that σ→\\vec{\\sigma} is a semi-strong Nash equilibrium if Γσ→\\Gamma^{\\vec{\\sigma}}. First, as observed in the previous section, it is easy to check that our construction of Γσ→\\Gamma^{\\vec{\\sigma}} satisfies the following property:

###### Lemma 1.

Given a strategy profile τ→\\vec{\\tau} for Γσ→\\Gamma^{\\vec{\\sigma}}, a player j∈Pj\\in P, and an action aj∈Aja\_{j}\\in A\_{j}, let p(j,aj)τ→p^{\\vec{\\tau}}\_{(j,a\_{j})} denote the probability that jj plays an action in Ajσ→A\_{j}^{\\vec{\\sigma}} such that its first component is aja\_{j}. Let x(j,aj)τ→x\_{(j,a\_{j})}^{\\vec{\\tau}} denote the expected additional utility of any other player when betting that jj plays action aja\_{j}. Then

|     |     |     |
| --- | --- | --- |
|  | x(j,aj)τ→=p(j,aj)τ→−p(j,aj)σ→x\_{(j,a\_{j})}^{\\vec{\\tau}}=p^{\\vec{\\tau}}\_{(j,a\_{j})}-p^{\\vec{\\sigma}}\_{(j,a\_{j})} |  |

###### Proof.

The expected additional utility can be computed as follows:

|     |     |     |
| --- | --- | --- |
|  | x(j,aj)τ→=p(j,aj)τ→​(1−p(j,aj)σ→)+(1−p(j,aj)τ→)​(−p(j,aj)σ→)=p(j,aj)τ→−p(j,aj)σ→.x\_{(j,a\_{j})}^{\\vec{\\tau}}=p^{\\vec{\\tau}}\_{(j,a\_{j})}\\left(1-p^{\\vec{\\sigma}}\_{(j,a\_{j})}\\right)+\\left(1-p^{\\vec{\\tau}}\_{(j,a\_{j})}\\right)\\left(-p^{\\vec{\\sigma}}\_{(j,a\_{j})}\\right)=p^{\\vec{\\tau}}\_{(j,a\_{j})}-p^{\\vec{\\sigma}}\_{(j,a\_{j})}. |  |

∎

With this, it is straightforward to check that, if C≥1C\\geq 1, σ→\\vec{\\sigma} is a (standard) Nash equilibrium of Γσ→\\Gamma^{\\vec{\\sigma}}: Fix a player ii and assume all other players play σ→−i\\vec{\\sigma}\_{-i}. Since σ→\\vec{\\sigma} is a Nash equilibrium of Γ\\Gamma, regardless of the bets ii places, it is a best response for ii to distribute the first component of its action in the same way as σi\\sigma\_{i}. It just remains to check that ii gets no utility from placing bets. By Lemma [1](https://arxiv.org/html/2312.14745v2#Thmlemma1 "Lemma 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), ii gets no utility from betting on other players. Moreover, if C≥1C\\geq 1, ii gets negative expected utility by betting on itself. This shows that σi\\sigma\_{i} is indeed a best response for ii.

Now suppose that σ→\\vec{\\sigma} does not satisfy the conditions of
Definition [1](https://arxiv.org/html/2312.14745v2#Thmdefinition1 "Definition 1. ‣ 2.2 Resilience to coalitions ‣ 2 Basic definitions ‣ Strengthening Nash Equilibria"). This would imply that there exists a
coalition S⊆PS\\subseteq P and a strategy profile τ→S\\vec{\\tau}\_{S} for players
in SS such that (a1) all players i∈Si\\in S get a strictly better expected
utility than ui​(σ→)u\_{i}(\\vec{\\sigma}), and (b1) no player i∈Si\\in S is better off
defecting from τ→S\\vec{\\tau}\_{S}, assuming that the rest of the players play
(σ→−S,τ→S∖{i})(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}}). Given a strategy
τi\\tau\_{i} for some player i∈Pi\\in P in Γσ→\\Gamma^{\\vec{\\sigma}}, denote by
τ~j\\tilde{\\tau}\_{j} the strategy for ii in Γ\\Gamma obtained by projecting the
actions of Ajσ→A\_{j}^{\\vec{\\sigma}} onto their first component (i.e., by getting
rid of the bets). Then, we have the following:

###### Proposition 1.

Let MM be the difference between the maximum and minimum utility of Γ\\Gamma. If SS and τ→S\\vec{\\tau}\_{S} satisfy (a1), there exist at least one player i∈Si\\in S such that τ~i≠σi\\tilde{\\tau}\_{i}\\not=\\sigma\_{i}.

###### Proof.

If all players i∈Si\\in S satisfy τ~i=σi\\tilde{\\tau}\_{i}=\\sigma\_{i}. Then, by Lemma [1](https://arxiv.org/html/2312.14745v2#Thmlemma1 "Lemma 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), none of the players in SS can increase their utility by placing a bet. This would imply that their expected utilities are at most the ones they would get when playing σ→S\\vec{\\sigma}\_{S}, which contradicts the (a1) assumption.

∎

Proposition [1](https://arxiv.org/html/2312.14745v2#Thmproposition1 "Proposition 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") implies that if a coalition SS with strategy τ→S\\vec{\\tau}\_{S} satisfies (a1), there exist at least one player i∈Si\\in S and an action ai∈Aia\_{i}\\in A\_{i} such that ii is more likely to play aia\_{i} in τ→S\\vec{\\tau}\_{S} than in σ→S\\vec{\\sigma}\_{S}. By Lemma [1](https://arxiv.org/html/2312.14745v2#Thmlemma1 "Lemma 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), betting that ii is going to play aia\_{i} gives a strictly positive utility to all other players. In particular, if SS and τ→S\\vec{\\tau}\_{S} satisfy (b1), all other players in SS must place bets on ii or other players in SS with probability 11 since there exist at least one bet with strictly positive expected utility. Since there is a finite number of possible bets, we have the following result.

###### Proposition 2.

Let q(i,ai)(j,τj)q\_{(i,a\_{i})}^{(j,\\tau\_{j})} be the probability that player jj bets on (i,ai)(i,a\_{i}) when playing τj\\tau\_{j}. Then, if SS and τ→S\\vec{\\tau}\_{S} satisfy (a1) and (b1), there exists a player i∈Si\\in S and an action ai∈Aia\_{i}\\in A\_{i} such that

|     |     |     |
| --- | --- | --- |
|  | ∑j∈Sq(i,ai)(j,τj)≥1\|A\|m​a​x,\\sum\_{j\\in S}q\_{(i,a\_{i})}^{(j,\\tau\_{j})}\\geq\\frac{1}{\|A\|\_{max}}, |  |

where \|A\|m​a​x=maxi⁡{\|Ai\|}\|A\|\_{max}=\\max\_{i}\\{\|A\_{i}\|\\}.

###### Proof.

By proposition [1](https://arxiv.org/html/2312.14745v2#Thmproposition1 "Proposition 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), there exists a player i∈Si\\in S such that τ~i≠σi\\tilde{\\tau}\_{i}\\not=\\sigma\_{i}. Because of (b1), if ii is the only player in SS such that τ~i≠σi\\tilde{\\tau}\_{i}\\not=\\sigma\_{i}, all other players in SS must bet on ii with probability 11. Since \|S\|≥2\|S\|\\geq 2, it follows that there exist an action a∈Aia\\in A\_{i} such that at least 1\|Ai\|\\frac{1}{\|A\_{i}\|} players bet on (i,ai)(i,a\_{i}) in expectation.

If there are at least two players i∈Si\\in S such that τ~i≠σi\\tilde{\\tau}\_{i}\\not=\\sigma\_{i} and SS and τ→S\\vec{\\tau}\_{S} satisfy (a1) and (b1), then all players in SS must place bets on other players in SS with probability 11. This means that, for a fixed j∈Sj\\in S,

|     |     |     |
| --- | --- | --- |
|  | ∑i∈S,ai∈Aiq(i,ai)(j,τj)=1.\\sum\_{i\\in S,\ a\_{i}\\in A\_{i}}q\_{(i,a\_{i})}^{(j,\\tau\_{j})}=1. |  |

If we add the equation above for all j∈Sj\\in S we get that

|     |     |     |
| --- | --- | --- |
|  | ∑i,j∈S,ai∈Aiq(i,ai)(j,τj)=\|S\|.\\sum\_{i,j\\in S,\ a\_{i}\\in A\_{i}}q\_{(i,a\_{i})}^{(j,\\tau\_{j})}=\|S\|. |  |

Rearranging the terms of the previous sum, we get

|     |     |     |
| --- | --- | --- |
|  | ∑i∈S,ai∈Ai(∑j∈Sq(i,ai)(j,τj))=\|S\|.\\sum\_{i\\in S,\ a\_{i}\\in A\_{i}}\\left(\\sum\_{j\\in S}q\_{(i,a\_{i})}^{(j,\\tau\_{j})}\\right)=\|S\|. |  |

Since the outer sum has at most \|S\|⋅\|A\|m​a​x\|S\|\\cdot\|A\|\_{max} elements, there exists i∈Si\\in S and ai∈Aia\_{i}\\in A\_{i} such that

|     |     |     |
| --- | --- | --- |
|  | ∑j∈Sq(i,ai)(j,τj)≥\|S\|\|S\|⋅\|A\|m​a​x=1\|A\|m​a​x,\\sum\_{j\\in S}q\_{(i,a\_{i})}^{(j,\\tau\_{j})}\\geq\\frac{\|S\|}{\|S\|\\cdot\|A\|\_{max}}=\\frac{1}{\|A\|\_{max}}, |  |

as desired.
∎

Proposition [2](https://arxiv.org/html/2312.14745v2#Thmproposition2 "Proposition 2. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") shows that, if SS and τ→S\\vec{\\tau}\_{S} satisfy (a1) and (b1), there exists a player i∈Pi\\in P and an action ai∈Aia\_{i}\\in A\_{i} such that at least a constant fraction of the players are betting on it in expectation. We next show that, if C>max⁡{M⋅\|A\|m​a​x,1}C>\\max\\{M\\cdot\|A\|\_{max},1\\}, ii can strictly increase its utility by decreasing the probability of playing aia\_{i}. This would contradict the fact that SS and τ→S\\vec{\\tau}\_{S} satisfy (b1) and prove Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria").

By Proposition [1](https://arxiv.org/html/2312.14745v2#Thmproposition1 "Proposition 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), the probability p(i,ai)τ→p^{\\vec{\\tau}}\_{(i,a\_{i})} that ii plays action aia\_{i} with strategy τ~i\\tilde{\\tau}\_{i} must satisfy p(i,ai)τ→>p(i,ai)σ→p^{\\vec{\\tau}}\_{(i,a\_{i})}>p^{\\vec{\\sigma}}\_{(i,a\_{i})} since, otherwise, players could get a better utility by betting somewhere else. The existence of aia\_{i} implies that there exists another action ai′∈Aia^{\\prime}\_{i}\\in A\_{i} such that p(i,ai′)τ→<p(i,ai′)σ→p^{\\vec{\\tau}}\_{(i,a^{\\prime}\_{i})}<p^{\\vec{\\sigma}}\_{(i,a^{\\prime}\_{i})} (i.e., an action that is played with less probability in τ~i\\tilde{\\tau}\_{i} than in σi\\sigma\_{i}).
Since SS and τ→S\\vec{\\tau}\_{S} satisfy (b1), it is guaranteed that no player will ever bet on (i,ai′)(i,a\_{i}^{\\prime}) since, by Lemma [1](https://arxiv.org/html/2312.14745v2#Thmlemma1 "Lemma 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), betting on it gives a strictly negative expected utility. Consider a strategy τi′\\tau\_{i}^{\\prime} in which ii plays in the same way as in τi\\tau\_{i}, except that ii plays ai′a\_{i}^{\\prime} whenever it would play aia\_{i} in τi\\tau\_{i}.

Then, we have that

|     |     |     |
| --- | --- | --- |
|  | uiσ→​(σ→−S,τ→S∖{i},τi′)−uiσ→​(σ→−S,τ→S)=ui​(σ→−S,τ~S∖{i},τ~i′)−ui​(σ→−S,τ~S)+wiσ→​(σ→−S,τ→S∖{i},τi′)−wiσ→​(σ→−S,τ→S)+ℓiσ→​(σ→−S,τ→S∖{i},τi′)−ℓiσ→​(σ→−S,τ→S).\\begin{array}\[\]{lll}u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i})-u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})&=&u\_{i}(\\vec{\\sigma}\_{-S},\\tilde{\\tau}\_{S\\setminus\\{i\\}},\\tilde{\\tau}^{\\prime}\_{i})-u\_{i}(\\vec{\\sigma}\_{-S},\\tilde{\\tau}\_{S})\\\<br>&+&w\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i})-w\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\\<br>&+&\\ell\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i})-\\ell\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}).\\end{array} |  |

Let p(i,ai)τ~ip\_{(i,a\_{i})}^{\\tilde{\\tau}\_{i}} be the probability that ii plays action aia\_{i} when following strategy τ~i\\tilde{\\tau}\_{i}. Then, we can bound the first term in the sum by

|     |     |     |
| --- | --- | --- |
|  | ui​(σ→−S,τ~S∖{i},τ~i′)−ui​(σ→−S,τ~S)≥−p(i,ai)τ~i​Mu\_{i}(\\vec{\\sigma}\_{-S},\\tilde{\\tau}\_{S\\setminus\\{i\\}},\\tilde{\\tau}^{\\prime}\_{i})-u\_{i}(\\vec{\\sigma}\_{-S},\\tilde{\\tau}\_{S})\\geq-p\_{(i,a\_{i})}^{\\tilde{\\tau}\_{i}}M |  |

since the difference in utility by switching from aia\_{i} to ai′a^{\\prime}\_{i} can be at most −M-M. Since τi′\\tau^{\\prime}\_{i} bets exactly in the same way as τi\\tau\_{i} does, we have that wiσ→​(σ→−S,τ→S∖{i},τi′)−wiσ→​(σ→−S,τ→S)=0w\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i})-w\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})=0. Finally, since the probability that another player bets on (i,ai)(i,a\_{i}) is at least 1\|Ai\|\\frac{1}{\|A\_{i}\|}, the following inequality holds:

|     |     |     |
| --- | --- | --- |
|  | ℓiσ→​(σ→−S,τ→S∖{i},τi′)−ℓiσ→​(σ→−S,τ→S)≥p(i,ai)τ~i​C\|Ai\|.\\ell\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i})-\\ell\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\geq p\_{(i,a\_{i})}^{\\tilde{\\tau}\_{i}}\\frac{C}{\|A\_{i}\|}. |  |

In the equation above, we are using the fact that the only difference between τi\\tau\_{i} and τi′\\tau^{\\prime}\_{i} is that ii is switching from aia\_{i} to another action ai′a^{\\prime}\_{i} that no player ever bets on. If C>M⋅\|A\|m​a​xC>M\\cdot\|A\|\_{max}, then

|     |     |     |
| --- | --- | --- |
|  | uiσ→​(σ→−S,τ→S∖{i},τi′)−uiσ→​(σ→−S,τ→S)≥p(i,ai)τ~i​C\|Ai\|−p(i,ai)τ~i​M>0.u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i})-u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\geq p\_{(i,a\_{i})}^{\\tilde{\\tau}\_{i}}\\frac{C}{\|A\_{i}\|}-p\_{(i,a\_{i})}^{\\tilde{\\tau}\_{i}}M>0. |  |

This would imply that ii can increase its utility by switching from τi\\tau\_{i} to τi′\\tau^{\\prime}\_{i}, which contradicts our original assumption that SS and τ→S\\vec{\\tau}\_{S} satisfy (b1).

#### 5.2.2 Part (b)

The proof of part (b) follows from the following proposition.

###### Proposition 3.

If τ→\\vec{\\tau} is a Nash equilibrium of Γσ\\Gamma^{\\sigma}, then τ~i=σi\\tilde{\\tau}\_{i}=\\sigma\_{i} for all i∈Pi\\in P.

Intuitively, this proposition says that all Nash equilibria of Γσ→\\Gamma^{\\vec{\\sigma}} are essentially σ→\\vec{\\sigma} with some bets on top of it. Note that if τ~i=σi\\tilde{\\tau}\_{i}=\\sigma\_{i} for all i∈Pi\\in P, wiw\_{i} gives exactly 00 utility for all strategies of ii. Since ℓi\\ell\_{i} is a negative function, Proposition [3](https://arxiv.org/html/2312.14745v2#Thmproposition3 "Proposition 3. ‣ 5.2.2 Part (b) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") implies that all Nash equilibria of Γσ→\\Gamma^{\\vec{\\sigma}} are Pareto-dominated by σ→\\vec{\\sigma}, as desired.

###### Proof of Proposition [3](https://arxiv.org/html/2312.14745v2\#Thmproposition3 "Proposition 3. ‣ 5.2.2 Part (b) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria").

Suppose that there exists a player ii such that τ~i≠σi\\tilde{\\tau}\_{i}\\not=\\sigma\_{i}. An analogous reasoning to the one used for proving Proposition [2](https://arxiv.org/html/2312.14745v2#Thmproposition2 "Proposition 2. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") shows that there exists a player i∈Pi\\in P and an action ai∈Aia\_{i}\\in A\_{i} such that

|     |     |     |
| --- | --- | --- |
|  | ∑j∈Sq(i,ai)τj≥1\|A\|m​a​x.\\sum\_{j\\in S}q\_{(i,a\_{i})}^{\\tau\_{j}}\\geq\\frac{1}{\|A\|\_{max}}. |  |

Then, analogously to the proof of part (a), it can be shown that ii can strictly increase its utility by switching from aia\_{i} to another action ai′a^{\\prime}\_{i}, contradicting the fact that τ→\\vec{\\tau} is a Nash equilibrium of Γσ\\Gamma^{\\sigma}.
∎

### 5.3 Generalization to Finite Bayesian Games with Independent Types

As shown in Section [4](https://arxiv.org/html/2312.14745v2#S4 "4 Sketch of the Proofs ‣ Strengthening Nash Equilibria"), the construction of Γσ→\\Gamma^{\\vec{\\sigma}} used for normal-form games does not work in general for Bayesian games. However, if types are independent, we have the following proposition that states that, if a coalition can defect in such a way that they all increase their expected utility with respect to σ→\\vec{\\sigma}, each player in the coalition must be able to tell the strategy of another member jj of the coalition from σj\\sigma\_{j}.

###### Proposition 4.

Let Γ=(P,T,q,A,U)\\Gamma=(P,T,q,A,U) be a Bayesian game with independent types. Let SS be a subset of players and τ→S\\vec{\\tau}\_{S} be a strategy profile for players in SS such that ui​(σ→−S,τ→S)>ui​(σ→)u\_{i}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})>u\_{i}(\\vec{\\sigma}) for all i∈Si\\in S. Then, there exists a player i∈Si\\in S and an action ai∈Aia\_{i}\\in A\_{i} such that

|     |     |     |
| --- | --- | --- |
|  | p(i,ai)τi>p(i,ai)σi,p\_{(i,a\_{i})}^{\\tau\_{i}}>p\_{(i,a\_{i})}^{\\sigma\_{i}}, |  |

where p(i,ai)τip\_{(i,a\_{i})}^{\\tau\_{i}} (resp., p(i,ai)σip\_{(i,a\_{i})}^{\\sigma\_{i}}) is the probability that player ii plays action aia\_{i} when following strategy τi\\tau\_{i} (resp., σi\\sigma\_{i}).

###### Proof.

Suppose that p(i,ai)τi=p(i,ai)σip\_{(i,a\_{i})}^{\\tau\_{i}}=p\_{(i,a\_{i})}^{\\sigma\_{i}} for all i∈Si\\in S and all ai∈Aia\_{i}\\in A\_{i}. Then, since types are independent, if we fix a player i∈Si\\in S and a type tit\_{i} of ii, the distribution over action profiles a→−i\\vec{a}\_{-i} played by the other players jj conditioned to the fact that ii has type tit\_{i} is identical when players in SS play τ→S\\vec{\\tau}\_{S} and when players in SS play σ→S\\vec{\\sigma}\_{S}. Therefore, we would have that

|     |     |     |
| --- | --- | --- |
|  | ui​(σ→−S,τ→S)=ui​(σ→−i,τi)u\_{i}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})=u\_{i}(\\vec{\\sigma}\_{-i},\\tau\_{i}) |  |

for all i∈Si\\in S, and thus

|     |     |     |
| --- | --- | --- |
|  | ui​(σ→−i,τi)>ui​(σ→),u\_{i}(\\vec{\\sigma}\_{-i},\\tau\_{i})>u\_{i}(\\vec{\\sigma}), |  |

which contradicts the fact that σ→\\vec{\\sigma} is a Nash equilibrium of Γ\\Gamma.
∎

Note that the proof of Proposition [4](https://arxiv.org/html/2312.14745v2#Thmproposition4 "Proposition 4. ‣ 5.3 Generalization to Finite Bayesian Games with Independent Types ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") requires that the types of the players are independent. In fact, if they were not, Example [2](https://arxiv.org/html/2312.14745v2#Thmexample2 "Example 2. ‣ 4 Sketch of the Proofs ‣ Strengthening Nash Equilibria") shows that players can defect in such a way that they all benefit while no player ii can tell between the strategy of another player jj and σj\\sigma\_{j}. However, in the case of independent types, Proposition [4](https://arxiv.org/html/2312.14745v2#Thmproposition4 "Proposition 4. ‣ 5.3 Generalization to Finite Bayesian Games with Independent Types ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") shows that we can use the same approach as in the case of normal-form games. Define Aσ→A^{\\vec{\\sigma}} as in Section [5.1](https://arxiv.org/html/2312.14745v2#S5.SS1 "5.1 Construction of Γ^𝜎 ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), and let

|     |     |     |
| --- | --- | --- |
|  | uiσ→​(ti,((a1,b1),(a2,b2),…,(an,bn))):⁣=ui​(ti,(a1,a2,…,an))+wiσ→​((a1,b1),(a2,b2),…,(an,bn))+ℓiσ→​((a1,b1),(a2,b2),…,(an,bn)),\\begin{array}\[\]{lll}u^{\\vec{\\sigma}}\_{i}(t\_{i},((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})))&:=&u\_{i}(t\_{i},(a\_{1},a\_{2},\\ldots,a\_{n}))\\\<br>&+&w\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n}))\\\<br>&+&\\ell\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})),\\end{array} |  |

where wiw\_{i} and ℓi\\ell\_{i} are defined in the same way as in Section [5.1](https://arxiv.org/html/2312.14745v2#S5.SS1 "5.1 Construction of Γ^𝜎 ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") and C>max⁡{M⋅\|A\|max,1}C>\\max\\{M\\cdot\|A\|\_{\\max},1\\}, as in Section [5.2](https://arxiv.org/html/2312.14745v2#S5.SS2 "5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"). An analogous reasoning to that of the proof of Proposition [2](https://arxiv.org/html/2312.14745v2#Thmproposition2 "Proposition 2. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") shows that, if SS and τ→S\\vec{\\tau}\_{S} satisfy that uiσ→​(σ→−S,τ→S)>uiσ→​(σ→)u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})>u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}) for all i∈Si\\in S, and that uiσ→​(σ→−S,τ→S)≥uiσ→​(σ→−S,τ→S∖{i},τi′)u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\geq u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i}) for all i∈Si\\in S and all strategies τi′\\tau^{\\prime}\_{i} for ii, then there exists a player ii and an action aia\_{i} such that, regardless of ii’s type, at least 1\|A\|m​a​x\\frac{1}{\|A\|\_{max}} players bet on (i,ai)(i,a\_{i}) in expectation. The rest of the proof proceeds as in the case of normal-form games.

## 6 Proof of Theorem [2](https://arxiv.org/html/2312.14745v2\#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") for Finite Bayesian Games

The analysis of Example [2](https://arxiv.org/html/2312.14745v2#Thmexample2 "Example 2. ‣ 4 Sketch of the Proofs ‣ Strengthening Nash Equilibria") given in Section [4](https://arxiv.org/html/2312.14745v2#S4 "4 Sketch of the Proofs ‣ Strengthening Nash Equilibria") shows that the construction used for normal-form games and for Bayesian games with independent types does not quite work in general for Bayesian games. However, note that if all three players play τ→\\vec{\\tau} in Example [2](https://arxiv.org/html/2312.14745v2#Thmexample2 "Example 2. ‣ 4 Sketch of the Proofs ‣ Strengthening Nash Equilibria"), even though player 11 cannot tell if player 22 or player 33 are going to play 00 or 11, she knows the following. If her type is 00, then players 22 and 33 are going to play either (0,1)(0,1) or (1,0)(1,0). Otherwise, they are going to play (0,0)(0,0) or (1,1)(1,1). This means that, even if ii cannot guess the action of another player jj with higher probability in τj\\tau\_{j} than in σj\\sigma\_{j}, she can guess the action profile of all other players with higher probability. This suggests that, instead of allowing players to bet on which action another player will play, they should be able to bet on action profiles of other players. This motivates the following construction. Define Γσ→:=(P,T,q,Aσ→,Uσ→)\\Gamma^{\\vec{\\sigma}}:=(P,T,q,A^{\\vec{\\sigma}},U^{\\vec{\\sigma}}). We define the action set Aiσ→A\_{i}^{\\vec{\\sigma}} of each player as Aiσ→:=Ai∪AA^{\\vec{\\sigma}}\_{i}:=A\_{i}\\cup A.
As in Section [5.1](https://arxiv.org/html/2312.14745v2#S5.SS1 "5.1 Construction of Γ^𝜎 ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), we can view each element of Aiσ→A^{\\vec{\\sigma}}\_{i} with a pair (a,b)(a,b), where aa is the actual action that ii plays and b∈A−ib\\in A\_{-i} is ii’s bet over the action profile of other players. Again, for convenience, whenever ii plays an action aia\_{i} without placing a bet, we will use the pair (ai,⊥)(a\_{i},\\bot) instead of aia\_{i}. The utility of each player ii is defined as follows:

|     |     |     |
| --- | --- | --- |
|  | uiσ→​((a1,b1),(a2,b2),…,(an,bn)):⁣=ui​(a1,a2,…,an)+wiσ→​((a1,b1),(a2,b2),…,(an,bn))+ℓiσ→​((a1,b1),(a2,b2),…,(an,bn)),\\begin{array}\[\]{lll}u^{\\vec{\\sigma}}\_{i}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n}))&:=&u\_{i}(a\_{1},a\_{2},\\ldots,a\_{n})\\\<br>&+&w\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n}))\\\<br>&+&\\ell\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})),\\end{array} |  |

where wiσ→w\_{i}^{\\vec{\\sigma}} and ℓiσ→\\ell\_{i}^{\\vec{\\sigma}} are defined similarly to their counterparts in Section [5.1](https://arxiv.org/html/2312.14745v2#S5.SS1 "5.1 Construction of Γ^𝜎 ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"). In this case, let pi,ti,a→−iσ→p^{\\vec{\\sigma}}\_{i,t\_{i},\\vec{a}\_{-i}} denote the probability that the action profile played by P−iP\_{-i} is a→−i\\vec{a}\_{-i}, conditioned to the fact that all players play σ→\\vec{\\sigma} and that player ii has type tit\_{i}. Then, we can define wiσ→w\_{i}^{\\vec{\\sigma}} as follows:

|     |     |     |
| --- | --- | --- |
|  | wiσ→​((a1,b1),(a2,b2),…,(an,bn)):={0if bi=⊥1−p(i,ti,a→−i)σ→if ​bi​ is of the form ​a→−i−p(i,ti,a→−i)σ→if ​bi​ is of the form ​a→i′​ with ​a→i′≠a→−i.w\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})):=\\left\\{\\begin{array}\[\]{ll}0&\\mbox{if }b\_{i}=\\bot\\\<br>1-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}&\\mbox{if }b\_{i}\\mbox{ is of the form }\\vec{a}\_{-i}\\\<br>-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}&\\mbox{if }b\_{i}\\mbox{ is of the form }\\vec{a}\_{i}^{\\prime}\\mbox{ with }\\vec{a}\_{i}^{\\prime}\\not=\\vec{a}\_{-i}.\\\<br>\\end{array}\\right. |  |

Finally, we define ℓiσ→:=∑j≠iℓ(i,j)σ→\\ell\_{i}^{\\vec{\\sigma}}:=\\sum\_{j\\not=i}\\ell\_{(i,j)}^{\\vec{\\sigma}}, where

|     |     |     |
| --- | --- | --- |
|  | ℓ(i,j)σ→​((a1,b1),(a2,b2),…,(an,bn)):={0if ​bj=⊥ or ​bj​ is of the form ​a→−j′​ with ​a→−j′≠a→−j−Cotherwise,\\ell\_{(i,j)}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})):=\\left\\{\\begin{array}\[\]{ll}0&\\mbox{if }b\_{j}=\\bot\\mbox{ or }b\_{j}\\mbox{ is of the form }\\vec{a}\_{-j}^{\\prime}\\mbox{ with }\\vec{a}\_{-j}^{\\prime}\\not=\\vec{a}\_{-j}\\\<br>-C&\\mbox{otherwise,}\\end{array}\\right. |  |

and C=2​\|A\|⋅(M+1)C=2\|A\|\\cdot(M+1). Note that, in this case, ℓ(i,j)\\ell\_{(i,j)} does not depend on ii.

To prove that this construction satisfies the properties of Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") we need a few preliminary lemmas. Before stating the first of these, we need the following definition. Given a player i∈Pi\\in P, a type ti∈Tit\_{i}\\in T\_{i}, and a strategy profile τ→\\vec{\\tau}, define Δ(i,ti)τ→\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}} as

|     |     |     |
| --- | --- | --- |
|  | Δ(i,ti)τ→=∑a→−i∈A−i\|p(i,ti,a→−i)σ→−p(i,ti,a→−i)τ→\|.\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}=\\sum\_{\\vec{a}\_{-i}\\in A\_{-i}}\\left\|p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}\\right\|. |  |

Intuitively, Δ(i,ti)τ→\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}} can be seen as the “Manhattan distance” between the distributions over actions played by P−iP\_{-i} that are generated when players play σ→\\vec{\\sigma} and τ→\\vec{\\tau} respectively, conditioned to the fact that ii has type tit\_{i}. Our first lemma states that, if players play τ→\\vec{\\tau}, the expected utility of a player ii with type tit\_{i} is bounded by its expected utility when players play σ→\\vec{\\sigma} plus Δ(i,ti)τ→⋅M\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}\\cdot M.

###### Lemma 2.

Given a player i∈Pi\\in P, its type ti∈Tit\_{i}\\in T\_{i}, and a strategy profile τ→\\vec{\\tau} for Γ\\Gamma, denote by ui​(ti,τ→)u\_{i}(t\_{i},\\vec{\\tau}) the expected utility of ii when players play τ→\\vec{\\tau}, conditioned to the fact that ii has type tit\_{i}. Then,

|     |     |     |
| --- | --- | --- |
|  | ui​(ti,τ→)≤ui​(ti,σ→)+Δ(i,ti)τ→⋅M.u\_{i}(t\_{i},\\vec{\\tau})\\leq u\_{i}(t\_{i},\\vec{\\sigma})+\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}\\cdot M. |  |

###### Proof.

Player ii’s expected utility when players play τ→\\vec{\\tau} conditioned to the fact that ii has type tit\_{i} is given by

|     |     |     |
| --- | --- | --- |
|  | ui​(ti,τ→)=∑ai∈Aiτi​(ti,ai)​(∑a−i∈A−ip(i,ti,a→−i)τ→​ui​(ti,a→)),u\_{i}(t\_{i},\\vec{\\tau})=\\sum\_{a\_{i}\\in A\_{i}}\\tau\_{i}(t\_{i},a\_{i})\\left(\\sum\_{a\_{-i}\\in A\_{-i}}p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}u\_{i}(t\_{i},\\vec{a})\\right), |  |

where τi​(ti,ai)\\tau\_{i}(t\_{i},a\_{i}) denotes the probability that ii plays aia\_{i} when following strategy τi\\tau\_{i}, conditioned to the fact that it has type tit\_{i}.

We can rewrite the sum as

|     |     |     |
| --- | --- | --- |
|  | ui​(ti,τ→)=∑ai∈Aiτi​(ti,ai)​(∑a−i∈A−ip(i,ti,a→−i)σ→​ui​(ti,a→)+(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→)​ui​(ti,a→)).u\_{i}(t\_{i},\\vec{\\tau})=\\sum\_{a\_{i}\\in A\_{i}}\\tau\_{i}(t\_{i},a\_{i})\\left(\\sum\_{a\_{-i}\\in A\_{-i}}p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}u\_{i}(t\_{i},\\vec{a})+(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}})u\_{i}(t\_{i},\\vec{a})\\right). |  |

Note that, since σ→\\vec{\\sigma} is a Nash equilibrium, we have that

|     |     |     |
| --- | --- | --- |
|  | ∑ai∈Aiτi​(ti,ai)​(∑a−i∈A−ip(i,ti,a→−i)σ→​ui​(ti,a→))≤ui​(ti,σ→).\\sum\_{a\_{i}\\in A\_{i}}\\tau\_{i}(t\_{i},a\_{i})\\left(\\sum\_{a\_{-i}\\in A\_{-i}}p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}u\_{i}(t\_{i},\\vec{a})\\right)\\leq u\_{i}(t\_{i},\\vec{\\sigma}). |  |

It remains to show that

|     |     |     |
| --- | --- | --- |
|  | ∑ai∈Aiτi​(ti,ai)​(∑a−i∈A−i(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→)​ui​(ti,a→))≤Δ(i,ti)τ→⋅M.\\sum\_{a\_{i}\\in A\_{i}}\\tau\_{i}(t\_{i},a\_{i})\\left(\\sum\_{a\_{-i}\\in A\_{-i}}(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}})u\_{i}(t\_{i},\\vec{a})\\right)\\leq\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}\\cdot M. |  |

Let Mm​i​nM\_{min} be the minimum utility of any player in Γ\\Gamma and Mm​a​xM\_{max} be the maximum utility of any player in Γ\\Gamma (recall that M=Mm​a​x−Mm​i​nM=M\_{max}-M\_{min}). Then,

|     |     |     |
| --- | --- | --- |
|  | ∑a−i∈A−i(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→)​ui​(ti,a→)=∑a−i∈A−i(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→)​(Mm​i​n+(ui​(ti,a→)−Mm​i​n)).\\sum\_{a\_{-i}\\in A\_{-i}}(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}})u\_{i}(t\_{i},\\vec{a})=\\sum\_{a\_{-i}\\in A\_{-i}}(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}})(M\_{min}+(u\_{i}(t\_{i},\\vec{a})-M\_{min})). |  |

Since ∑a−i∈A−ip(i,ti,a→−i)τ→=∑a−i∈A−ip(i,ti,a→−i)σ→=1\\sum\_{a\_{-i}\\in A\_{-i}}p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}=\\sum\_{a\_{-i}\\in A\_{-i}}p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}=1, we have that

|     |     |     |
| --- | --- | --- |
|  | ∑a−i∈A−i(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→)​(Mm​i​n+(ui​(ti,a→)−Mm​i​n))=∑a−i∈A−i(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→)​(ui​(ti,a→)−Mm​i​n)≤∑a−i∈A−i\|p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→\|⋅(Mm​a​x−Mm​i​n)=Δ(i,ti)τ→⋅M.\\begin{array}\[\]{ll}&\\sum\_{a\_{-i}\\in A\_{-i}}(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}})(M\_{min}+(u\_{i}(t\_{i},\\vec{a})-M\_{min}))\\\<br>=&\\sum\_{a\_{-i}\\in A\_{-i}}(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}})(u\_{i}(t\_{i},\\vec{a})-M\_{min})\\\<br>\\leq&\\sum\_{a\_{-i}\\in A\_{-i}}\\left\|p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}\\right\|\\cdot(M\_{max}-M\_{min})\\\<br>=&\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}\\cdot M.\\end{array} |  |

Therefore,

|     |     |     |
| --- | --- | --- |
|  | ∑ai∈Aiτi​(ti,ai)​(∑a−i∈A−i(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→)​ui​(ti,a→))≤(Δ(i,ti)τ→⋅M)​∑ai∈Aiτi​(ti,ai)=Δ(i,ti)τ→⋅M,\\begin{array}\[\]{ll}&\\sum\_{a\_{i}\\in A\_{i}}\\tau\_{i}(t\_{i},a\_{i})\\left(\\sum\_{a\_{-i}\\in A\_{-i}}(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}})u\_{i}(t\_{i},\\vec{a})\\right)\\\<br>\\leq&(\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}\\cdot M)\\sum\_{a\_{i}\\in A\_{i}}\\tau\_{i}(t\_{i},a\_{i})\\\<br>=&\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}\\cdot M,\\end{array} |  |

as desired.

∎

The second preliminary lemma gives the expected utility that a player can get by betting on the other players’ actions.

###### Lemma 3.

Given a player i∈Pi\\in P, its type ti∈Tit\_{i}\\in T\_{i}, and a strategy profile τ→\\vec{\\tau} for Γσ→\\Gamma^{\\vec{\\sigma}}. The expected utility that ii gets when betting on action profile a→−i\\vec{a}\_{-i} is given by p(i,ti,a→−i)τ→−p(i,ti,a→−i).p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}.

The proof of Lemma [3](https://arxiv.org/html/2312.14745v2#Thmlemma3 "Lemma 3. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria") is equivalent to that of Lemma [1](https://arxiv.org/html/2312.14745v2#Thmlemma1 "Lemma 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"). The following corollary is a direct implication.

###### Corollary 1.

Given a player i∈Pi\\in P, its type ti∈Tit\_{i}\\in T\_{i}, and a Nash equilibrium τ→\\vec{\\tau} for Γσ→\\Gamma^{\\vec{\\sigma}}. The maximum expected utility wi​(ti,τ→i)w\_{i}(t\_{i},\\vec{\\tau}\_{i}) that ii can get by betting when players play τ→\\vec{\\tau} and ii has type tit\_{i} satisfies

|     |     |     |
| --- | --- | --- |
|  | wi​(ti,τ→i)≤Δ(i,ti)τ→w\_{i}(t\_{i},\\vec{\\tau}\_{i})\\leq\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}} |  |

###### Proof.

By Lemma [3](https://arxiv.org/html/2312.14745v2#Thmlemma3 "Lemma 3. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria"), the maximum utility that ii can get by betting, conditioned to the fact that ii has type tit\_{i} and players play τ→\\vec{\\tau} is given by

|     |     |     |
| --- | --- | --- |
|  | maxa→−i∈A−i⁡{p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→}.\\max\_{\\vec{a}\_{-i}\\in A\_{-i}}\\{p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}\\}. |  |

By definition, this value is at most Δ(i,ti)τ→\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}.
∎

The third and final preliminary lemma gives a lower bound on the expected losses of other players incurred by ii’s bets.

###### Lemma 4.

Given a player i∈Pi\\in P, its type ti∈Tit\_{i}\\in T\_{i}, and a Nash equilibrium τ→\\vec{\\tau} for Γσ→\\Gamma^{\\vec{\\sigma}}, denote by ℓj,iσ→​(ti,τ→)\\ell\_{j,i}^{\\vec{\\sigma}}(t\_{i},\\vec{\\tau}) the expected utility that jj loses because of ii’s bet, conditioned to the fact that ii plays τi\\tau\_{i} with type tit\_{i}. Then,

|     |     |     |
| --- | --- | --- |
|  | ℓj,iσ→​(ti,τ→)≤−Δ(i,ti)τ→​C2​\|A−i\|.\\ell\_{j,i}^{\\vec{\\sigma}}(t\_{i},\\vec{\\tau})\\leq-\\frac{\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}C}{2\|A\_{-i}\|}. |  |

###### Proof.

If Δ(i,ti)τ→=0\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}=0, the lemma is automatically true since ℓj,iσ→​(ti,τ→)≤0\\ell\_{j,i}^{\\vec{\\sigma}}(t\_{i},\\vec{\\tau})\\leq 0. Therefore, for the rest of the proof we will assume that Δ(i,ti)τ→>0\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}>0, and thus that there exists an action profile a→−i\\vec{a}\_{-i} such that p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→>0p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}>0. By Lemma [3](https://arxiv.org/html/2312.14745v2#Thmlemma3 "Lemma 3. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria"), this implies that there exists at least one bet for ii that gives her strictly positive utility, and therefore that ii will always bet with probability 11 since τ→\\vec{\\tau} is a Nash equilibrium.

Let

|     |     |     |
| --- | --- | --- |
|  | X:=∑a→−i∈A−ip(i,ti,a→−i)τ→−p(i,ti,a→−i)≥0(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→)X:=\\sum\_{\\begin{subarray}{c}\\vec{a}\_{-i}\\in A\_{-i}\\\<br>p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}\\geq 0\\end{subarray}}(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}) |  |

and

|     |     |     |
| --- | --- | --- |
|  | Y:=∑a→−i∈A−ip(i,ti,a→−i)τ→−p(i,ti,a→−i)<0(p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→).Y:=\\sum\_{\\begin{subarray}{c}\\vec{a}\_{-i}\\in A\_{-i}\\\<br>p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}<0\\end{subarray}}(p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}). |  |

We have that

|     |     |     |
| --- | --- | --- |
|  | X+Y=∑a→−i∈A−ip(i,ti,a→−i)τ→−∑a→−i∈A−ip(i,ti,a→−i)σ→=0.X+Y=\\sum\_{\\vec{a}\_{-i}\\in A\_{-i}}p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-\\sum\_{\\vec{a}\_{-i}\\in A\_{-i}}p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}=0. |  |

Moreover, by definition, X−Y=Δ(i,ti)τ→.X-Y=\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}. Putting the last two equations together we get that X=Δ(i,ti)τ→2X=\\frac{\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}}{2}. Therefore, since XX is a sum of at most \|A−i\|\|A\_{-i}\| terms, there exists an action profile a→−i∈A−i\\vec{a}\_{-i}\\in A\_{-i} such that

|     |     |     |
| --- | --- | --- |
|  | p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→≥1\|A−i\|⋅Δ(i,ti)τ→2=Δ(i,ti)τ→2​\|A−i\|.p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}\\geq\\frac{1}{\|A\_{-i}\|}\\cdot\\frac{\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}}{2}=\\frac{\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}}{2\|A\_{-i}\|}. |  |

We show next that the loss of every other player when ii bets on an action that maximizes p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}} is upper-bounded by −Δ(i,ti)τ→​C2​\|A−i\|-\\frac{\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}C}{2\|A\_{-i}\|}. Note that this completes the proof since, by Lemma [3](https://arxiv.org/html/2312.14745v2#Thmlemma3 "Lemma 3. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria"), ii will always bet on actions that maximize p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}} since τ→\\vec{\\tau} is a Nash equilibrium.

Let a→−i\\vec{a}\_{-i} be an action profile that maximizes p(i,ti,a→−i)τ→−p(i,ti,a→−i)σ→p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}-p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}. The expected loss ℓj,iσ→​(ti,a→−i)\\ell\_{j,i}^{\\vec{\\sigma}}(t\_{i},\\vec{a}\_{-i}) of every other player jj when ii bets on a→−i\\vec{a}\_{-i} and ii has type tit\_{i} is given by

|     |     |     |
| --- | --- | --- |
|  | ℓj,iσ→​(ti,a→−i)=p(i,ti,a→−i)τ→⋅(−C).\\ell\_{j,i}^{\\vec{\\sigma}}(t\_{i},\\vec{a}\_{-i})=p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}\\cdot(-C). |  |

Since p(i,ti,a→−i)τ→≥p(i,ti,a→−i)σ→+Δ(i,ti)τ→2​\|A−i\|≥Δ(i,ti)τ→2​\|A−i\|p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\tau}}\\geq p\_{(i,t\_{i},\\vec{a}\_{-i})}^{\\vec{\\sigma}}+\\frac{\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}}{2\|A\_{-i}\|}\\geq\\frac{\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}}{2\|A\_{-i}\|}, we get that

|     |     |     |
| --- | --- | --- |
|  | ℓj,iσ→​(ti,a→−i)≤−Δ(i,ti)τ→​C2​\|A−i\|,\\ell\_{j,i}^{\\vec{\\sigma}}(t\_{i},\\vec{a}\_{-i})\\leq-\\frac{\\Delta\_{(i,t\_{i})}^{\\vec{\\tau}}C}{2\|A\_{-i}\|}, |  |

and this completes the proof.
∎

With Lemmas [2](https://arxiv.org/html/2312.14745v2#Thmlemma2 "Lemma 2. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria") and [4](https://arxiv.org/html/2312.14745v2#Thmlemma4 "Lemma 4. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria"), and Corollary [1](https://arxiv.org/html/2312.14745v2#Thmcorollary1 "Corollary 1. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria"), we are ready to prove Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria"). Let SS be a coalition of players and τ→S\\vec{\\tau}\_{S} be a strategy profile for players in SS such that (a1) uiσ→​(σ→−S,τ→S)>uiσ→​(σ→)u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})>u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}) for all i∈Si\\in S, and (b1) uiσ→​(σ→−S,τ→S)≥uiσ→​(σ→−S,τ→S∖{i},τi′)u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\geq u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i}) for all i∈Si\\in S and all strategies τi′\\tau^{\\prime}\_{i} for ii. By construction, we have that

|     |     |     |
| --- | --- | --- |
|  | uiσ→​(σ→−S,τ→S)=ui​(σ→−S,τ~S)+wiσ→​(σ→−S,τ→S)+ℓiσ→​(σ→−S,τ→S).\\begin{array}\[\]{lll}u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})&=&u\_{i}(\\vec{\\sigma}\_{-S},\\tilde{\\tau}\_{S})\\\<br>&+&w\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\\<br>&+&\\ell\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}).\\end{array} |  |

If we denote by p⁡(i,ti)p(i,t\_{i}) the probability that ii gets type tit\_{i} according to distribution pp, can rewrite the previous identity as

|     |     |     |
| --- | --- | --- |
|  | uiσ→​(σ→−S,τ→S)=∑ti∈Tip⁡(i,ti)​ui​(ti,(σ→−S,τ~S))+∑ti∈Tip⁡(i,ti)​wiσ→​(ti,(σ→−S,τ→S))+∑j∈S∖{i}ℓ(i,j)σ→​(σ→−S,τ→S).\\begin{array}\[\]{lll}u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})&=&\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})u\_{i}(t\_{i},(\\vec{\\sigma}\_{-S},\\tilde{\\tau}\_{S}))\\\<br>&+&\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})w\_{i}^{\\vec{\\sigma}}(t\_{i},(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}))\\\<br>&+&\\sum\_{j\\in S\\setminus\\{i\\}}\\ell\_{(i,j)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}).\\end{array} |  |

Applying Lemma [2](https://arxiv.org/html/2312.14745v2#Thmlemma2 "Lemma 2. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria") and Corollary [1](https://arxiv.org/html/2312.14745v2#Thmcorollary1 "Corollary 1. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria") we get that

|     |     |     |
| --- | --- | --- |
|  | uiσ→​(σ→−S,τ→S)≤∑ti∈Tip⁡(i,ti)​(ui​(ti,σ→)+Δ(i,ti)(σ→−S,τ~S)⋅M)+∑ti∈Tip⁡(i,ti)​Δ(i,ti)(σ→−S,τ→S)+∑j∈S∖{i}ℓ(i,j)σ→​(σ→−S,τ→S),\\begin{array}\[\]{lll}u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})&\\leq&\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})(u\_{i}(t\_{i},\\vec{\\sigma})+\\Delta^{(\\vec{\\sigma}\_{-S},\\tilde{\\tau}\_{S})}\_{(i,t\_{i})}\\cdot M)\\\<br>&+&\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}\\\<br>&+&\\sum\_{j\\in S\\setminus\\{i\\}}\\ell\_{(i,j)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}),\\end{array} |  |

which can be written as

|     |     |     |
| --- | --- | --- |
|  | uiσ→​(σ→−S,τ→S)≤∑ti∈Tip⁡(i,ti)​(ui​(ti,σ→)+Δ(i,ti)(σ→−S,τ→S)⋅(M+1))+∑j∈S∖{i}ℓ(i,j)σ→​(σ→−S,τ→S),\\begin{array}\[\]{lll}u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})&\\leq&\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})(u\_{i}(t\_{i},\\vec{\\sigma})+\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}\\cdot(M+1))\\\<br>&+&\\sum\_{j\\in S\\setminus\\{i\\}}\\ell\_{(i,j)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}),\\end{array} |  |

By linearity of expectation, this implies that

|     |     |     |     |
| --- | --- | --- | --- |
|  | ∑i∈Suiσ→​(σ→−S,τ→S)≤∑i∈S∑ti∈Tip⁡(i,ti)​(ui​(ti,σ→)+Δ(i,ti)(σ→−S,τ→S)⋅(M+1))+∑i∈S∑j∈S∖{i}ℓ(i,j)σ→​(σ→−S,τ→S).\\begin{array}\[\]{lll}\\sum\_{i\\in S}u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})&\\leq&\\sum\_{i\\in S}\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})(u\_{i}(t\_{i},\\vec{\\sigma})+\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}\\cdot(M+1))\\\<br>&+&\\sum\_{i\\in S}\\sum\_{j\\in S\\setminus\\{i\\}}\\ell\_{(i,j)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}).\\end{array} |  | (1) |

Note that ∑i∈S∑j∈S∖{i}ℓ(i,j)σ→​(σ→−S,τ→S)=∑i∈S∑j∈S∖{i}ℓ(j,i)σ→​(σ→−S,τ→S)\\sum\_{i\\in S}\\sum\_{j\\in S\\setminus\\{i\\}}\\ell\_{(i,j)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})=\\sum\_{i\\in S}\\sum\_{j\\in S\\setminus\\{i\\}}\\ell\_{(j,i)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}). Moreover, we can write
ℓ(j,i)σ→​(σ→−S,τ→S)\\ell\_{(j,i)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}) as ∑ti∈Tip⁡(i,ti)​ℓ(j,i)σ→​(ti,(σ→−S,τ→S))\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})\\ell\_{(j,i)}^{\\vec{\\sigma}}(t\_{i},(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})). Therefore, by Lemma [4](https://arxiv.org/html/2312.14745v2#Thmlemma4 "Lemma 4. ‣ 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria"), we get that

|     |     |     |
| --- | --- | --- |
|  | ℓ(j,i)σ→(σ→−S,τ→S)≤∑ti∈Ti−p(i,ti)⋅Δ(i,ti)(σ→−S,τ→S)​C2​\|A−i\|.\\ell\_{(j,i)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\leq\\sum\_{t\_{i}\\in T\_{i}}-p(i,t\_{i})\\cdot\\frac{\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}C}{2\|A\_{-i}\|}. |  |

This implies that

|     |     |     |
| --- | --- | --- |
|  | ∑i∈S∑j∈S∖{i}ℓ(j,i)σ→(σ→−S,τ→S)≤∑i∈S∑ti∈Ti−p(i,ti)⋅(\|S\|−1)⋅Δ(i,ti)(σ→−S,τ→S)​C2​\|A−i\|\\sum\_{i\\in S}\\sum\_{j\\in S\\setminus\\{i\\}}\\ell\_{(j,i)}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\leq\\sum\_{i\\in S}\\sum\_{t\_{i}\\in T\_{i}}-p(i,t\_{i})\\cdot(\|S\|-1)\\cdot\\frac{\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}C}{2\|A\_{-i}\|} |  |

Inserting this into Equation [1](https://arxiv.org/html/2312.14745v2#S6.E1 "In 6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria") gives that

|     |     |     |
| --- | --- | --- |
|  | ∑i∈Suiσ→​(σ→−S,τ→S)≤∑i∈S∑ti∈Tip⁡(i,ti)​\[(ui​(ti,σ→)+Δ(i,ti)(σ→−S,τ→S)⋅(M+1))−(\|S\|−1)⋅Δ(i,ti)(σ→−S,τ→S)​C2​\|A−i\|\].\\sum\_{i\\in S}u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\leq\\sum\_{i\\in S}\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})\\left\[(u\_{i}(t\_{i},\\vec{\\sigma})+\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}\\cdot(M+1))-(\|S\|-1)\\cdot\\frac{\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}C}{2\|A\_{-i}\|}\\right\]. |  |

Since C=2​\|A\|⋅(M+1)C=2\|A\|\\cdot(M+1), it follows that

|     |     |     |
| --- | --- | --- |
|  | (\|S\|−1)⋅Δ(i,ti)(σ→−S,τ→S)​C2​\|A−i\|≥Δ(i,ti)(σ→−S,τ→S)⋅(M+1),(\|S\|-1)\\cdot\\frac{\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}C}{2\|A\_{-i}\|}\\geq\\Delta^{(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})}\_{(i,t\_{i})}\\cdot(M+1), |  |

and therefore

|     |     |     |
| --- | --- | --- |
|  | ∑i∈Suiσ→​(σ→−S,τ→S)≤∑i∈S∑ti∈Tip⁡(i,ti)​ui​(ti,σ→)=∑i∈Sui​(σ→).\\sum\_{i\\in S}u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\leq\\sum\_{i\\in S}\\sum\_{t\_{i}\\in T\_{i}}p(i,t\_{i})u\_{i}(t\_{i},\\vec{\\sigma})=\\sum\_{i\\in S}u\_{i}(\\vec{\\sigma}). |  |

This implies that there exists at least one player i∈Si\\in S such that uiσ→​(σ→−S,τ→S)≤ui​(σ→)u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\leq u\_{i}(\\vec{\\sigma}), which contradicts the (a1) assumption. This proves Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") part (a). Part (b) follows from the same argument with S=PS=P.

## 7 Proof of Theorems [1](https://arxiv.org/html/2312.14745v2\#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and [2](https://arxiv.org/html/2312.14745v2\#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria"), Infinite Case

As stated in Section [3](https://arxiv.org/html/2312.14745v2#S3 "3 Main Results ‣ Strengthening Nash Equilibria"), the proof of Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") can be generalized to games in which the sets of actions and types are infinite. We’ll prove this generalization in the case where Γ\\Gamma is a normal-form game. The generalization in the case of Bayesian games is identical, except that we use the proofs and constructions from Sections [5.3](https://arxiv.org/html/2312.14745v2#S5.SS3 "5.3 Generalization to Finite Bayesian Games with Independent Types ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") and [6](https://arxiv.org/html/2312.14745v2#S6 "6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria") as a starting point (as opposed to the proofs and constructions of Section [5.2](https://arxiv.org/html/2312.14745v2#S5.SS2 "5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria")).

For ease of exposition, we will begin by generalizing the constructions given in previous sections to games with a countable number of actions. The proof for arbitrary sets is given in Section [7.2](https://arxiv.org/html/2312.14745v2#S7.SS2 "7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") and follows the same lines.

### 7.1 Countable Case

As suggested by Example [3](https://arxiv.org/html/2312.14745v2#Thmexample3 "Example 3. ‣ 4 Sketch of the Proofs ‣ Strengthening Nash Equilibria"), the proof given in Section [5.1](https://arxiv.org/html/2312.14745v2#S5.SS1 "5.1 Construction of Γ^𝜎 ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") does not quite work when the sets of actions are infinite. In fact, the construction for finite games uses the fact that if a coalition SS defects, there exists a player ii and an action aa such that 1\|A\|m​a​x\\frac{1}{\|A\|\_{max}} of the players bet on (i,a)(i,a) in expectation. This allowed us to adjust CC so that it is never beneficial for ii to play aa. If the game is infinite, there is no lower bound of the expected number of players that bet on a particular action, and therefore there is no value of CC that does the trick.

We can avoid this problem by slightly modifying the bet space. Suppose that instead of betting on pairs (i,a)(i,a) with i∈Pi\\in P and a∈Aia\\in A\_{i}, players can bet on pairs (i,X)(i,X) with i∈Pi\\in P and X⊆AiX\\subseteq A\_{i}. Given the actions and bets (a1,b1),…,(an,bn)(a\_{1},b\_{1}),\\ldots,(a\_{n},b\_{n}) of the players, we define the utilities of Γσ→\\Gamma^{\\vec{\\sigma}} as in Section [5.1](https://arxiv.org/html/2312.14745v2#S5.SS1 "5.1 Construction of Γ^𝜎 ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria"), except that

|     |     |     |
| --- | --- | --- |
|  | wiσ→((a1,b1),(a2,b2),…,(an,bn)):={0if bi=⊥1−p(j,X)σ→if bi is of the form (j,X) with aj∈X−p(j,X)σ→if bi is of the form (j,X) with aj∉Xw\_{i}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})):=\\left\\{\\begin{array}\[\]{ll}0&\\mbox{if }b\_{i}=\\bot\\\<br>1-p\_{(j,X)}^{\\vec{\\sigma}}&\\mbox{if }b\_{i}\\mbox{ is of the form }(j,X)\\mbox{ with<br>}a\_{j}\\in X\\\<br>-p\_{(j,X)}^{\\vec{\\sigma}}&\\mbox{if }b\_{i}\\mbox{ is of the form }(j,X)\\mbox{ with<br>}a\_{j}\\not\\in X\\\<br>\\end{array}\\right. |  |

where p(j,X)σ→p\_{(j,X)}^{\\vec{\\sigma}} is the probability that the first component of jj’s action is in XX, assuming that jj uses strategy σj\\sigma\_{j}, and

|     |     |     |
| --- | --- | --- |
|  | ℓ(i,j)σ→​((a1,b1),(a2,b2),…,(an,bn)):={0if ​bj=⊥ or ​bj​ is of the form ​(i,X)​ with ​a∉X−M−1otherwise,\\ell\_{(i,j)}^{\\vec{\\sigma}}((a\_{1},b\_{1}),(a\_{2},b\_{2}),\\ldots,(a\_{n},b\_{n})):=\\left\\{\\begin{array}\[\]{ll}0&\\mbox{if }b\_{j}=\\bot\\mbox{ or }b\_{j}\\mbox{ is of the form }(i,X)\\mbox{ with }a\\not\\in X\\\<br>-M-1&\\mbox{otherwise,}\\end{array}\\right. |  |

where MM is the difference between the supremum and the infimum utility that a player can get in Γ\\Gamma. An analogous reasoning to that of Lemma [1](https://arxiv.org/html/2312.14745v2#Thmlemma1 "Lemma 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") shows that the expected utility x(j,aj)τjx^{\\tau\_{j}}\_{(j,a\_{j})} that a player gets by betting on (j,X)(j,X) conditioned to the fact that jj is playing strategy τj\\tau\_{j}, is given by

|     |     |     |
| --- | --- | --- |
|  | x(j,aj)τj:=p(j,X)τj−p(j,X)σj.x^{\\tau\_{j}}\_{(j,a\_{j})}:=p\_{(j,X)}^{\\tau\_{j}}-p\_{(j,X)}^{\\sigma\_{j}}. |  |

This implies that if player jj plays some action aa with more probability in τj\\tau\_{j} than in σj\\sigma\_{j}, including action aa in XX strictly increases the expected utility of betting on (j,X)(j,X). This proves the following lemma.

###### Lemma 5.

Given a normal-form game Γ=(P,A,U)\\Gamma=(P,A,U), let S⊂PS\\subset P be a subset of players and τ→S\\vec{\\tau}\_{S} be a strategy for players in SS in Γσ→\\Gamma^{\\vec{\\sigma}} such that uiσ→​(σ→−S,τ→S)≥uiσ→​(σ→−S,τ→S∖{i},τi′)u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S})\\geq u\_{i}^{\\vec{\\sigma}}(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S\\setminus\\{i\\}},\\tau^{\\prime}\_{i}) for all i∈Si\\in S and all strategies τi′\\tau^{\\prime}\_{i} for ii. For each player i∈Si\\in S, let Xi>X\_{i}^{>} (resp., Xi<X\_{i}^{<}) be the set of all actions a∈Aia\\in A\_{i} such that the probability that ii plays aa with τ~i\\tilde{\\tau}\_{i} is strictly greater (resp., smaller) than the probability that ii plays aa with σi\\sigma\_{i}. Then, all bets of the form (i,X)(i,X) that may occur with positive probability when playing (σ→−S,τ→S)(\\vec{\\sigma}\_{-S},\\vec{\\tau}\_{S}) must satisfy that Xi>⊆XX\_{i}^{>}\\subseteq X and Xi<∩X=∅X\_{i}^{<}\\cap X=\\emptyset.

With Lemma [5](https://arxiv.org/html/2312.14745v2#Thmlemma5 "Lemma 5. ‣ 7.1 Countable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"), we can use a similar argument to the one used in the finite case. Suppose that a coalition SS defects from the proposed strategy following strategy profile τ→S\\vec{\\tau}\_{S} in such a way that (a1) all players in SS get more utility with τ→S\\vec{\\tau}\_{S} than with σ→\\vec{\\sigma} and (b1) no player in SS can further increase its utility by defecting from τ→S\\vec{\\tau}\_{S}. Then, it is straightforward to check that, if (a1) is satisfied, all players in SS bet with probability 11. Therefore, there exists a player i∈Si\\in S such that at least one other player bets on ii in expectation. By Lemma [5](https://arxiv.org/html/2312.14745v2#Thmlemma5 "Lemma 5. ‣ 7.1 Countable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"), all of these bets must include all elements in Xi>X\_{i}^{>} and none of them includes any element of Xi<X\_{i}^{<}. Therefore, if ii reduces the probability of playing any action in Xi>X\_{i}^{>} by δ\\delta and increases the probability of playing any action in Xi<X\_{i}^{<} by δ\\delta, an analogous reasoning to the one at the end of Section [5.2](https://arxiv.org/html/2312.14745v2#S5.SS2 "5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") shows that the utility of ii increases at least by

|     |     |     |
| --- | --- | --- |
|  | δ⁡(M+1)−δ​M,\\delta(M+1)-\\delta M, |  |

which contradicts the (b1) assumption. The proof for Bayesian games follow the same generalization (betting on sets of actions or action profiles rather than on individual actions or action profiles), using as a basis the constructions in Sections [5.3](https://arxiv.org/html/2312.14745v2#S5.SS3 "5.3 Generalization to Finite Bayesian Games with Independent Types ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") and  [6](https://arxiv.org/html/2312.14745v2#S6 "6 Proof of Theorem for Finite Bayesian Games ‣ Strengthening Nash Equilibria").

### 7.2 Uncountable Case

The idea used for the countable case can be generalized for any probability space, although the proof is much more technical. We begin by giving the basic notions on probability theory, and then move to the desired generalization.

#### 7.2.1 Basic Definitions

Given a set XX, a _σ\\sigma-algebra_ on XX is a collection Σ\\Sigma of subsets of XX that is closed under complement, countable unions, and countable intersections. This means that,

- •


Y∈Σ⟹Y¯∈ΣY\\in\\Sigma\\Longrightarrow\\overline{Y}\\in\\Sigma, where Y¯\\overline{Y} denotes the complement of YY in XX (i.e., X∖YX\\setminus Y).

- •


If {Xi}i=1∞\\{X\_{i}\\}\_{i=1}^{\\infty} is a countable collection of elements of Σ\\Sigma, then both ⋃i≥1Xi\\bigcup\_{i\\geq 1}X\_{i} and ⋃i≥1Xi\\bigcup\_{i\\geq 1}X\_{i} are also elements of Σ\\Sigma.


A pair (X,Σ)(X,\\Sigma) consisting of a set XX and a σ\\sigma-algebra Σ\\Sigma on XX is called a _measurable space_. Given a measurable space (X,Σ)(X,\\Sigma), a measure on (X,Σ)(X,\\Sigma) is a function μ:Σ⟶ℝ∪{−∞,+∞}\\mu:\\Sigma\\longrightarrow\\mathbb{R}\\cup\\{-\\infty,+\\infty\\} that satisfies

- •


μ⁡(∅)=0\\mu(\\emptyset)=0.

- •


Non-negativity:μ⁡(Y)≥0\\mu(Y)\\geq 0 for all Y∈ΣY\\in\\Sigma.

- •


Countable additivity: For all countable collections {Xi}i=1∞\\{X\_{i}\\}\_{i=1}^{\\infty} of pairwise disjoint sets in Σ\\Sigma, μ⁡(⋃i=1∞Xi)=∑i=1∞μ⁡(Xi)\\mu(\\bigcup\_{i=1}^{\\infty}X\_{i})=\\sum\_{i=1}^{\\infty}\\mu(X\_{i}).


Intuitively, a measure is a non-negative function that assigns 00 to the empty set and such that the measure of a countable union disjoint sets is the sum of their measures.

With these definitions, we can define a probability space. A probability space is a tuple (X,Σ,P)(X,\\Sigma,P), where (X,Σ)(X,\\Sigma) is a σ\\sigma-algebra, and PP is a measure such that the image of all elements of Σ\\Sigma is in \[0,1\]\[0,1\], and such that the measure of the whole space is 11. More precisely, PP must satisfy that

- •


P⁡(E)∈\[0,1\]P(E)\\in\[0,1\] for all E∈ΣE\\in\\Sigma.

- •


P⁡(X)=1P(X)=1.


In the next sections we will assume that, in a normal-form game Γ\\Gamma, the action sets AiA\_{i} of each player have an embedded σ\\sigma-algebra Σi\\Sigma\_{i}, and the strategy of each player ii consists of choosing a measure QiQ\_{i} such that (Ai,Σi,Qi)(A\_{i},\\Sigma\_{i},Q\_{i}) is a probability space. Intuitively, this means that ii cannot choose which sets of AiA\_{i} are measurable, but it can choose what probability it is assigned to each of these sets (i.e., with what probability each action is sampled). Given the strategy PiP\_{i} of each player,
the probability space (A,Σ,Q)(A,\\Sigma,Q) that gives the probability of each subset of action profiles when each player plays QiQ\_{i} is precisely the product of (Ai,Σi,Pi)(A\_{i},\\Sigma\_{i},P\_{i}) for all i∈Pi\\in P, in which A:=A1×A2×…×AnA:=A\_{1}\\times A\_{2}\\times\\ldots\\times A\_{n}, Σ:=σ⁡(Σ1⊗…⊗Σn)\\Sigma:=\\sigma(\\Sigma\_{1}\\otimes\\ldots\\otimes\\Sigma\_{n}) (i.e., the σ\\sigma-algebra generated by sets of the form (X1,…,Xn)(X\_{1},\\ldots,X\_{n}) with Xi∈ΣiX\_{i}\\in\\Sigma\_{i} for all ii), and Q:=Q1×…×QnQ:=Q\_{1}\\times\\ldots\\times Q\_{n}, which is the unique measure function such that Q⁡(X1,…,Xn)=Q1​(X1)​Q2​(X2)​…​Qn​(Xn)Q(X\_{1},\\ldots,X\_{n})=Q\_{1}(X\_{1})Q\_{2}(X\_{2})\\ldots Q\_{n}(X\_{n}). Fixing (A,Σ,Q)(A,\\Sigma,Q), the expected utility of a player ii is given by the Lebesgue integral

|     |     |     |
| --- | --- | --- |
|  | ui​(Q):=∫Aui​(X)​𝑑Q.u\_{i}(Q):=\\int\_{A}u\_{i}(X)\ dQ. |  |

In order to avoid confusion between the strategy profile σ→\\vec{\\sigma} of Theorems [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and the σ\\sigma used in the definition of σ\\sigma-algebras, in the next sections we will use QQ instead of σ→\\vec{\\sigma} to denote the Nash equilibrium of Theorems [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria").

#### 7.2.2 Construction of ΓQ\\Gamma^{Q}

The construction of ΓQ\\Gamma^{Q} for arbitrary probability spaces is quite similar to the one given in Section [7.1](https://arxiv.org/html/2312.14745v2#S7.SS1 "7.1 Countable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"). In fact, we define AiQ:=Ai∪(Ai×⋃j∈P({j}×Σj))A\_{i}^{Q}:=A\_{i}\\cup\\left(A\_{i}\\times\\bigcup\_{j\\in P}(\\{j\\}\\times\\Sigma\_{j})\\right). Intuitively, ii can either play an action in AiA\_{i}, or play an action in AiA\_{i} and simultaneously bet that the action that another player jj plays is in some measurable subset S∈ΣjS\\in\\Sigma\_{j}. The σ\\sigma-algebra of AiQA\_{i}^{Q} is the one spanned by Σi\\Sigma\_{i} and σ⁡(Σi⊗𝒫⁡({j}×Σj))\\sigma(\\Sigma\_{i}\\otimes\\mathcal{P}(\\{j\\}\\times\\Sigma\_{j})) for each j∈Pj\\in P (where 𝒫⁡(S)\\mathcal{P}(S) denotes the power set of a set SS).

We define UQU^{Q} exactly in the same way as in Section [7.1](https://arxiv.org/html/2312.14745v2#S7.SS1 "7.1 Countable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"). Note that p(j,X)Qp\_{(j,X)}^{Q} is well defined since, by construction, XX must belong to Σj\\Sigma\_{j}. In fact, p(j,X)Q=Qj​(X)p\_{(j,X)}^{Q}=Q\_{j}(X).

#### 7.2.3 High Level Proof

A similar argument to the one given in Lemma [1](https://arxiv.org/html/2312.14745v2#Thmlemma1 "Lemma 1. ‣ 5.2.1 Part (a) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") shows that, if players follow strategy profile Q′Q^{\\prime}, the expected utility that a player ii gets when betting on (j,S)(j,S) for some S∈ΣjS\\in\\Sigma\_{j} is given by Q~j′​(S)−Qj​(S)\\tilde{Q}^{\\prime}\_{j}(S)-Q\_{j}(S) (where, again, Q~′\\tilde{Q}^{\\prime} is the projection of Q′Q^{\\prime} onto its first component). Therefore, it is optimal for player ii to bet on sets that maximize Q~j′​(S)−Qj​(S)\\tilde{Q}^{\\prime}\_{j}(S)-Q\_{j}(S) with probability 11. However, it is not clear at first if such a bet always exists, since it could be the case that the supremum of {Q~j′​(S)−Qj​(S)}S∈Σj\\{\\tilde{Q}^{\\prime}\_{j}(S)-Q\_{j}(S)\\}\_{S\\in\\Sigma\_{j}} is never attained in Σj\\Sigma\_{j}. The first part of the proof is precisely showing that such a bet always exists.

###### Proposition 5.

Let ΓQ\\Gamma^{Q} be the game constructed in Section [7.2.2](https://arxiv.org/html/2312.14745v2#S7.SS2.SSS2 "7.2.2 Construction of Γ^𝑄 ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") and let j∈Pj\\in P be a player that plays strategy Qj′Q^{\\prime}\_{j}. Then, for all other players i∈Pi\\in P, there exists a maximal and a minimal bet of the form (j,X)(j,X).

The proof of Proposition [5](https://arxiv.org/html/2312.14745v2#Thmproposition5 "Proposition 5. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") is somewhat technical and will be shown in Section [7.2.4](https://arxiv.org/html/2312.14745v2#S7.SS2.SSS4 "7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"). Once we have Proposition [5](https://arxiv.org/html/2312.14745v2#Thmproposition5 "Proposition 5. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"), the second part of the proof is showing that, among all sets XX that maximize or minimize the bets on jj, there exists one that minimizes Q⁡(X)Q(X).

###### Proposition 6.

Let ΓQ\\Gamma^{Q} be the game constructed in Section [7.2.2](https://arxiv.org/html/2312.14745v2#S7.SS2.SSS2 "7.2.2 Construction of Γ^𝑄 ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") and let j∈Pj\\in P be a player that plays strategy Qj′Q^{\\prime}\_{j}. Let ΣQj′+\\Sigma\_{Q^{\\prime}\_{j}}^{+} and ΣQj′−\\Sigma\_{Q^{\\prime}\_{j}}^{-} be the subsets of Σj\\Sigma\_{j} that maximize and minimize Q~j′​(S)−Qj​(S)\\tilde{Q}^{\\prime}\_{j}(S)-Q\_{j}(S), respectively. Then, there exists a set X+∈ΣQj′+X^{+}\\in\\Sigma\_{Q^{\\prime}\_{j}}^{+} and a set X−∈ΣQj′−X^{-}\\in\\Sigma\_{Q^{\\prime}\_{j}}^{-} such that X+∩X−=∅X^{+}\\cap X^{-}=\\emptyset, Q⁡(X+)≤Q⁡(X)Q(X^{+})\\leq Q(X) for all X∈ΣQj′+X\\in\\Sigma\_{Q^{\\prime}\_{j}}^{+} and Q⁡(X−)≤Q⁡(X)Q(X^{-})\\leq Q(X) for all X∈ΣQj′−X\\in\\Sigma\_{Q^{\\prime}\_{j}}^{-}.

The proof of Proposition [6](https://arxiv.org/html/2312.14745v2#Thmproposition6 "Proposition 6. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") is quite similar to that of Proposition [5](https://arxiv.org/html/2312.14745v2#Thmproposition5 "Proposition 5. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") and is also shown in Section [7.2.4](https://arxiv.org/html/2312.14745v2#S7.SS2.SSS4 "7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"). With these propositions we are ready to give complete the proof of correctness of the construction given in Section [7.2.2](https://arxiv.org/html/2312.14745v2#S7.SS2.SSS2 "7.2.2 Construction of Γ^𝑄 ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"). Suppose that a subset SS of players with \|S\|≥2\|S\|\\geq 2 defects from QSQ\_{S} to another strategy profile QS′Q^{\\prime}\_{S} in such a way that (a1) uiQ​(Q−S,QS′)>uiQ​(Q)u\_{i}^{Q}(Q\_{-S},Q^{\\prime}\_{S})>u\_{i}^{Q}(Q) for all i∈Si\\in S, and (b1) uiQ​(Q−S,QS∖{i}′,Qi′′)≤uiQ​(Q−S,QS′)u\_{i}^{Q}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{i\\}},Q^{\\prime\\prime}\_{i})\\leq u\_{i}^{Q}(Q\_{-S},Q^{\\prime}\_{S}) for all i∈Si\\in S and all strategies Qi′′Q^{\\prime\\prime}\_{i} for ii. Then, there must exist a player i∈Si\\in S and a subset X∈ΣiX\\in\\Sigma\_{i} such that Q~i′​(X)≠Qi​(X)\\tilde{Q}^{\\prime}\_{i}(X)\\not=Q\_{i}(X) since, otherwise, all bets would give 00 expected utility and all players would get at most the expected utility they’d get with QQ, which contradicts (a). If Q~i′​(X)≠Qi​(X)\\tilde{Q}^{\\prime}\_{i}(X)\\not=Q\_{i}(X), it means that either Q~i′​(X)−Qi​(X)>0\\tilde{Q}^{\\prime}\_{i}(X)-Q\_{i}(X)>0 or Q~i′​(X¯)−Qi​(X¯)>0\\tilde{Q}^{\\prime}\_{i}(\\overline{X})-Q\_{i}(\\overline{X})>0, which implies that all other players in SS must place bets with probability 11 (otherwise, it contradicts (b1)). It is easy to check that, if this is the case, there exists a player jj such that the expected number of other players that bet on jj is at least 11. Let X+X^{+} and X−X^{-} be the subsets given in Proposition [6](https://arxiv.org/html/2312.14745v2#Thmproposition6 "Proposition 6. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") (for player jj) and consider a strategy Qj′′Q^{\\prime\\prime}\_{j} bets in the same way as in Qj′Q^{\\prime}\_{j} but that intuitively does the following in order to select an action in AjA\_{j}:

1. 1.


Step 1:jj samples an action aa according to Qj′Q^{\\prime}\_{j}.

2. 2.


Step 2: If a∉X+a\\not\\in X^{+}, jj plays aa.

3. 3.


Step 3: Otherwise, jj sequentially samples an action aa according to QjQ\_{j} until a∈X−a\\in X^{-}. Then, jj plays aa.


Note that this algorithm always terminates since Q~j′​(X−)−Qj​(X−)<0\\tilde{Q}^{\\prime}\_{j}(X^{-})-Q\_{j}(X^{-})<0, which means that Qj​(X−)>0Q\_{j}(X^{-})>0. More precisely, what jj is doing is selecting an action in AiA\_{i} according to the probability measure Q~j′′\\tilde{Q}^{\\prime\\prime}\_{j} on (Aj,Σj)(A\_{j},\\Sigma\_{j}) defined by

|     |     |     |
| --- | --- | --- |
|  | Q~j′′​(X):=Q~j′​(X∖X+)+Q~j′​(X+)Qj​(X−)​Qj​(X∩X−).\\tilde{Q}^{\\prime\\prime}\_{j}(X):=\\tilde{Q}^{\\prime}\_{j}(X\\setminus X^{+})+\\frac{\\tilde{Q}^{\\prime}\_{j}(X^{+})}{Q\_{j}(X^{-})}Q\_{j}(X\\cap X^{-}). |  |

It is straightforward to check that Q~j′′​(X)\\tilde{Q}^{\\prime\\prime}\_{j}(X) is indeed a probability measure on (Aj,Σj)(A\_{j},\\Sigma\_{j}):

- •


Q~j′′​(∅)=Q~j′​(∅)+Q~j′​(X+)Qj​(X−)​Qj​(∅)=0\\tilde{Q}^{\\prime\\prime}\_{j}(\\emptyset)=\\tilde{Q}^{\\prime}\_{j}(\\emptyset)+\\frac{\\tilde{Q}^{\\prime}\_{j}(X^{+})}{Q\_{j}(X^{-})}Q\_{j}(\\emptyset)=0.

- •


Q~j′′​(Aj)=Q~j′​(Aj)−Q~j′​(X+)+Q~j′​(X+)Qj​(X−)​Qj​(X−)=1\\tilde{Q}^{\\prime\\prime}\_{j}(A\_{j})=\\tilde{Q}^{\\prime}\_{j}(A\_{j})-\\tilde{Q}^{\\prime}\_{j}(X^{+})+\\frac{\\tilde{Q}^{\\prime}\_{j}(X^{+})}{Q\_{j}(X^{-})}Q\_{j}(X^{-})=1.

- •


If {Xi}i≥1\\{X\_{i}\\}\_{i\\geq 1} is a countable sequence of pairwise disjoint subsets in Σj\\Sigma\_{j}, we have that (⋃i≥1Xi)∖X+=⋃i≥1(Xi∖X+)\\left(\\bigcup\_{i\\geq 1}X\_{i}\\right)\\setminus X^{+}=\\bigcup\_{i\\geq 1}(X\_{i}\\setminus X^{+}), and (⋃i≥1Xi)∩X−=⋃i≥1(Xi∩X−)\\left(\\bigcup\_{i\\geq 1}X\_{i}\\right)\\cap X^{-}=\\bigcup\_{i\\geq 1}(X\_{i}\\cap X^{-}). Moreover, the subsets of the form Xi∖X+X\_{i}\\setminus X^{+} are pairwise disjoint, and so are those of the form Xi∩X−X\_{i}\\cap X^{-}. Therefore,



|     |     |     |
| --- | --- | --- |
|  | Q~j′′​(⋃i≥1Xi)=∑i≥1Q~j′​(Xi∖X+)+Q~j′​(X+)Qj​(X−)​∑i≥1Qj​(Xi∩X−)=∑i≥1Q~j′′​(Xi).\\tilde{Q}^{\\prime\\prime}\_{j}\\left(\\bigcup\_{i\\geq 1}X\_{i}\\right)=\\sum\_{i\\geq 1}\\tilde{Q}^{\\prime}\_{j}(X\_{i}\\setminus X^{+})+\\frac{\\tilde{Q}^{\\prime}\_{j}(X^{+})}{Q\_{j}(X^{-})}\\sum\_{i\\geq 1}Q\_{j}(X\_{i}\\cap X^{-})=\\sum\_{i\\geq 1}\\tilde{Q}^{\\prime\\prime}\_{j}(X\_{i}). |  |


We show next that jj strictly improves its utility by switching from Qj′Q^{\\prime}\_{j} to Qj′′Q^{\\prime\\prime}\_{j}. Recall that the expected utility ujQ​(Q−S,QS∖{j}′,Qj′′)u\_{j}^{Q}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j}) that jj gets when playing strategy Qj′′Q^{\\prime\\prime}\_{j} can be decomposed as

|     |     |     |
| --- | --- | --- |
|  | ujQ​(Q−S,QS∖{j}′,Qj′′)=uj​(Q−S,Q~S∖{j}′,Q~j′′)+wj​(Q−S,QS∖{j}′,Qj′′)+ℓj​(Q−S,QS∖{j}′,Qj′′).\\begin{array}\[\]{lll}u\_{j}^{Q}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j})&=&u\_{j}(Q\_{-S},\\tilde{Q}^{\\prime}\_{S\\setminus\\{j\\}},\\tilde{Q}^{\\prime\\prime}\_{j})\\\<br>&+&w\_{j}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j})\\\<br>&+&\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j}).\\\<br>\\end{array} |  |

As in previous sections, wj​(Q−S,QS∖{j}′,Qj′′)=wj​(Q−S,QS′)w\_{j}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j})=w\_{j}(Q\_{-S},Q^{\\prime}\_{S}) since, by construction, jj places the same bets in Qj′Q^{\\prime}\_{j} and Qj′′Q^{\\prime\\prime}\_{j}. We finish with the following lemma, whose proof is given in Section [7.2.4](https://arxiv.org/html/2312.14745v2#S7.SS2.SSS4 "7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria").

###### Lemma 6.

|     |     |     |
| --- | --- | --- |
|  | uj​(Q−S,Q~S∖{j}′,Q~j′′)−uj​(Q−S,Q~S′)≤Qj′​(X+)​Mℓj​(Q−S,QS∖{j}′,Qj′′)−ℓj​(Q−S,QS′)>Qj′​(X+)​M.\\begin{array}\[\]{ll}u\_{j}(Q\_{-S},\\tilde{Q}^{\\prime}\_{S\\setminus\\{j\\}},\\tilde{Q}^{\\prime\\prime}\_{j})-u\_{j}(Q\_{-S},\\tilde{Q}^{\\prime}\_{S})\\leq Q^{\\prime}\_{j}(X^{+})M\\\<br>\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j})-\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S})>Q^{\\prime}\_{j}(X^{+})M.\\end{array} |  |

Note that this lemma implies that ujQ​(Q−S,QS∖{j}′,Qj′′)>uj​(Q−S,QS′)u\_{j}^{Q}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j})>u\_{j}(Q\_{-S},Q^{\\prime}\_{S}), contradicting the (b1) assumption. This completes the proof of Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") part (a). A similar argument can be used to prove part (b), as done in Section [5.2.2](https://arxiv.org/html/2312.14745v2#S5.SS2.SSS2 "5.2.2 Part (b) ‣ 5.2 Proof of Correctness ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria").

#### 7.2.4 Proof of the Technical Results

In this section, we prove the technical propositions and lemmas given in the previous section.

We begin with Proposition [5](https://arxiv.org/html/2312.14745v2#Thmproposition5 "Proposition 5. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"). Its proof follows from the following lemma.

###### Lemma 7.

Let Σ\\Sigma be a σ\\sigma-algebra and let f:Σ⟶ℝf:\\Sigma\\longrightarrow\\mathbb{R} be a bounded function. Then, ff has a global minimum and a global maximum on Σ\\Sigma.

Note that Proposition [5](https://arxiv.org/html/2312.14745v2#Thmproposition5 "Proposition 5. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") is an immediate consequence of Lemma [7](https://arxiv.org/html/2312.14745v2#Thmlemma7 "Lemma 7. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") since the expected utility of a bet is bounded between 11 and −1-1. To prove Lemma [7](https://arxiv.org/html/2312.14745v2#Thmlemma7 "Lemma 7. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") we need the following well-known result.

###### Lemma 8.

Let Σ\\Sigma be a σ\\sigma-algebra on some set Ω\\Omega, let {Xn}n≥1\\{X\_{n}\\}\_{n\\geq 1} be a sequence of elements of Σ\\Sigma, and let ff be a function from Σ\\Sigma to ℝ\\mathbb{R} that satisfies countable additivity and such that

- (a)


Xn⊆Xn+1X\_{n}\\subseteq X\_{n+1} for all n∈ℕn\\in\\mathbb{N}, and

- (b)


limn→∞f⁡(Xn)=L\\lim\_{n\\rightarrow\\infty}f(X\_{n})=L, for some L∈ℝL\\in\\mathbb{R}.


Then f⁡(⋃n≥1Xn)=Lf\\left(\\bigcup\_{n\\geq 1}X\_{n}\\right)=L.

###### Proof.

Let Yn:=Xn+1∖XnY\_{n}:=X\_{n+1}\\setminus X\_{n}. Then, by (a), X1X\_{1} and all sets YnY\_{n} are pairwise disjoint. Therefore, since ff satisfies countable additivity, we have that

|     |     |     |
| --- | --- | --- |
|  | f⁡(⋃i=1nXi)=f⁡(Xn)=f⁡(X1)+∑i=1n−1f⁡(Yi).f\\left(\\bigcup\_{i=1}^{n}X\_{i}\\right)=f(X\_{n})=f(X\_{1})+\\sum\_{i=1}^{n-1}f(Y\_{i}). |  |

Since limn→∞f⁡(Xn)=L\\lim\_{n\\rightarrow\\infty}f(X\_{n})=L, it means that the sum is convergent and the limit is equal to L−f⁡(X1)L-f(X\_{1}). Therefore,

|     |     |     |
| --- | --- | --- |
|  | f⁡(⋃n≥1Xn)=f⁡(X1)+∑i=1∞f⁡(Yi)=L.f\\left(\\bigcup\_{n\\geq 1}X\_{n}\\right)=f(X\_{1})+\\sum\_{i=1}^{\\infty}f(Y\_{i})=L. |  |

∎

To prove Lemma [7](https://arxiv.org/html/2312.14745v2#Thmlemma7 "Lemma 7. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") we also need the following observation.

###### Lemma 9.

Let Σ\\Sigma be a σ\\sigma-algebra on some set Ω\\Omega and let ff be a function from Σ\\Sigma to ℝ\\mathbb{R} that satisfies countable additivity and such that f⁡(X)≤Lf(X)\\leq L for all X∈ΣX\\in\\Sigma. Let a1,a2,…,ana\_{1},a\_{2},\\ldots,a\_{n} be a finite sequence of positive real numbers and X1,X2,…,XnX\_{1},X\_{2},\\ldots,X\_{n} be a finite sequence of elements of Σ\\Sigma such that f⁡(Xi)>L−aif(X\_{i})>L-a\_{i}. Then,

|     |     |     |
| --- | --- | --- |
|  | f⁡(⋂i=1nXi)>L−∑i=1naif\\left(\\bigcap\_{i=1}^{n}X\_{i}\\right)>L-\\sum\_{i=1}^{n}a\_{i} |  |

.

###### Proof.

We will only show this result for n=2n=2. The general case follows by induction.

Given two sets XX and YY in Σ\\Sigma such that f⁡(X)>L−af(X)>L-a and f⁡(Y)>L−bf(Y)>L-b, let X′=X∖YX^{\\prime}=X\\setminus Y and let Y′=Y∖XY^{\\prime}=Y\\setminus X. Then, we have that

|     |     |     |
| --- | --- | --- |
|  | f⁡(X′)+f⁡(X∩Y)>L−af⁡(Y′)+f⁡(X∩Y)>L−bf⁡(X∪Y)≤L\\begin{array}\[\]{lll}f(X^{\\prime})+f(X\\cap Y)&>&L-a\\\<br>f(Y^{\\prime})+f(X\\cap Y)&>&L-b\\\<br>f(X\\cup Y)&\\leq&L\\end{array} |  |

Writing X∪YX\\cup Y as X′∪Y′∪(X∩Y)X^{\\prime}\\cup Y^{\\prime}\\cup(X\\cap Y), we can add the first two equations and substract the third one to get the desired result.
∎

With these lemmas we are ready to prove Lemma [7](https://arxiv.org/html/2312.14745v2#Thmlemma7 "Lemma 7. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria").

###### Proof of Lemma [7](https://arxiv.org/html/2312.14745v2\#Thmlemma7 "Lemma 7. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria").

We will only show that ff has a global maximum since, if XX is a global maximum of ff, then X¯\\overline{X} is a global minimum (and viceversa). Let LL be the supremum of {f⁡(X)}X∈Σ\\{f(X)\\}\_{X\\in\\Sigma} and let X1,X2,…X\_{1},X\_{2},\\ldots be a sequence of elements of Σ\\Sigma such that f⁡(Xn)>L−12nf(X\_{n})>L-\\frac{1}{2^{n}}. Let Ymn=⋂i=mnXiY\_{m}^{n}=\\bigcap\_{i=m}^{n}X\_{i}. By Lemma [9](https://arxiv.org/html/2312.14745v2#Thmlemma9 "Lemma 9. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") we have that f⁡(Ymn)>L−∑i=mn12i=L−(12m−1−12n)f(Y\_{m}^{n})>L-\\sum\_{i=m}^{n}\\frac{1}{2^{i}}=L-(\\frac{1}{2^{m-1}}-\\frac{1}{2^{n}}).

If we take the limit when n→∞n\\rightarrow\\infty, we have that f⁡(Ym∞)>L−12m−1f(Y\_{m}^{\\infty})>L-\\frac{1}{2^{m-1}} (note that Ym∞∈ΣY\_{m}^{\\infty}\\in\\Sigma since Σ\\Sigma is closed under countable intersections). By construction, Ym∞⊆Ym+1∞Y\_{m}^{\\infty}\\subseteq Y\_{m+1}^{\\infty} for all m∈ℕm\\in\\mathbb{N}. Moreover,

|     |     |     |
| --- | --- | --- |
|  | limm→∞f⁡(Ym∞)=limm→∞L−12m−1=L.\\lim\_{m\\rightarrow\\infty}f(Y\_{m}^{\\infty})=\\lim\_{m\\rightarrow\\infty}L-\\frac{1}{2^{m-1}}=L. |  |

By Lemma [8](https://arxiv.org/html/2312.14745v2#Thmlemma8 "Lemma 8. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"), this means that

|     |     |     |
| --- | --- | --- |
|  | f⁡(⋃m=1∞Ym∞)=L.f\\left(\\bigcup\_{m=1}^{\\infty}Y\_{m}^{\\infty}\\right)=L. |  |

This completes the proof.
∎

The proof of Proposition [6](https://arxiv.org/html/2312.14745v2#Thmproposition6 "Proposition 6. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") is analogous to that of Proposition [5](https://arxiv.org/html/2312.14745v2#Thmproposition5 "Proposition 5. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"). The key observation is that the set of maximal and the set of minimal bets are closed under countable unions and intersections, which means that we can do an analogue of the proof of Lemma [7](https://arxiv.org/html/2312.14745v2#Thmlemma7 "Lemma 7. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") restricted to ΣQj+\\Sigma\_{Q\_{j}^{+}} and to ΣQj−\\Sigma\_{Q\_{j}^{-}}. To prove this, note that if ff is a countably additive bounded function defined on a σ\\sigma-algebra Σ\\Sigma, we have that f⁡(X)=f⁡(X∩Y)+f⁡(X∖Y)f(X)=f(X\\cap Y)+f(X\\setminus Y) and f⁡(Y)=f⁡(X∩Y)+f⁡(Y∖X)f(Y)=f(X\\cap Y)+f(Y\\setminus X) for any two sets X,Y∈ΣX,Y\\in\\Sigma. If Both XX and YY maximize ff, then f⁡(Y∖X)=f⁡(X∖Y)=0f(Y\\setminus X)=f(X\\setminus Y)=0. Otherwise, f⁡(X∩Y)f(X\\cap Y) or f⁡(X∪Y)f(X\\cup Y) would be strictly greater than f⁡(X)f(X). This implies that f⁡(X∩Y)=f⁡(X∪Y)=f⁡(X)=f⁡(Y)f(X\\cap Y)=f(X\\cup Y)=f(X)=f(Y).

It is important to note that if we restrict the proof of Lemma [7](https://arxiv.org/html/2312.14745v2#Thmlemma7 "Lemma 7. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") to ΣQj+\\Sigma\_{Q\_{j}^{+}} and to ΣQj−\\Sigma\_{Q\_{j}^{-}}, finding the minimum does not reduce to finding the maximum (as we did in Lemma [7](https://arxiv.org/html/2312.14745v2#Thmlemma7 "Lemma 7. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria")) since ΣQj+\\Sigma\_{Q\_{j}^{+}} and ΣQj−\\Sigma\_{Q\_{j}^{-}} are not closed under complements. However, we can reproduce an analogous proof using analogues to Lemma [8](https://arxiv.org/html/2312.14745v2#Thmlemma8 "Lemma 8. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") and Lemma [9](https://arxiv.org/html/2312.14745v2#Thmlemma9 "Lemma 9. ‣ 7.2.4 Proof of the Technical Results ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") for intersections and infimums, respectively. Finally, note that we can assume w.l.o.g. that the sets X+X^{+} and X−X^{-} in Proposition [6](https://arxiv.org/html/2312.14745v2#Thmproposition6 "Proposition 6. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria") are disjoint since, if X+∩X−≠∅X^{+}\\cap X^{-}\\not=\\emptyset, then we can use the same argument as above to show that Qj′​(X∩​X−)=Qj​(X∩​X−)=0Q^{\\prime}\_{j}(X^{\\cap}X^{-})=Q\_{j}(X^{\\cap}X^{-})=0. If this happens, we can take X+∖X−X^{+}\\setminus X^{-} and X−∖X+X^{-}\\setminus X^{+} instead of X+X^{+} and X−X^{-}.

It remains to show Lemma [6](https://arxiv.org/html/2312.14745v2#Thmlemma6 "Lemma 6. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria").

###### Proof of Lemma [6](https://arxiv.org/html/2312.14745v2\#Thmlemma6 "Lemma 6. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria").

We prove each equation separately.

First equation: uj​(Q−S,Q~S∖{j}′,Q~j′′)−uj​(Q−S,Q~S′)≤Qj′​(X+)​Mu\_{j}(Q\_{-S},\\tilde{Q}^{\\prime}\_{S\\setminus\\{j\\}},\\tilde{Q}^{\\prime\\prime}\_{j})-u\_{j}(Q\_{-S},\\tilde{Q}^{\\prime}\_{S})\\leq Q^{\\prime}\_{j}(X^{+})M.

For simplicity, let RR denote the strategy profile where players in SS play Q~S′\\tilde{Q}^{\\prime}\_{S} and the rest of the players play Q−SQ\_{-S}.

By definition,

|     |     |     |
| --- | --- | --- |
|  | uj​(R−j,Q~j′′)=∫Auj​(X)​d​(R−j,Q~j′′).u\_{j}(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})=\\int\_{A}u\_{j}(X)\ d(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j}). |  |

We can split AA into Ω1:=X+×A−i\\Omega\_{1}:=X^{+}\\times A\_{-i} and Ω2:=(Ai∖X+)×A−i\\Omega\_{2}:=(A\_{i}\\setminus X^{+})\\times A\_{-i} to get

|     |     |     |
| --- | --- | --- |
|  | uj​(R−j,Q~j′′)=∫Ω1uj​(X)​d​(R−j,Q~j′′)+∫Ω2uj​(X)​d​(R−j,Q~j′′).u\_{j}(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})=\\int\_{\\Omega\_{1}}u\_{j}(X)\ d(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})+\\int\_{\\Omega\_{2}}u\_{j}(X)\ d(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j}). |  |

By construction, Qj′′​(X)=0Q\_{j}^{\\prime\\prime}(X)=0 for all X⊆X+X\\subseteq X^{+}, which means that ∫Ω1uj​(X)​d​(R−j,Q~j′′)=0\\int\_{\\Omega\_{1}}u\_{j}(X)\ d(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})=0. Additionally, if we define Ω3:=X−×A−i\\Omega\_{3}:=X^{-}\\times A\_{-i}, we have that

|     |     |     |
| --- | --- | --- |
|  | ∫Ω2uj​(X)​d​(R−j,Q~j′′)=∫Ω2uj​(X)​𝑑R+Q~j′​(X+)Qj​(X−)​∫Ω3uj​(X)​d​(R−j,Qj).\\int\_{\\Omega\_{2}}u\_{j}(X)\ d(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})=\\int\_{\\Omega\_{2}}u\_{j}(X)\ dR+\\frac{\\tilde{Q}^{\\prime}\_{j}(X^{+})}{Q\_{j}(X^{-})}\\int\_{\\Omega\_{3}}u\_{j}(X)\ d(R\_{-j},Q\_{j}). |  |

Note that
uj​(R)=∫Ω2uj​(X)​𝑑R+∫Ω1uj​(X)​𝑑Ru\_{j}(R)=\\int\_{\\Omega\_{2}}u\_{j}(X)\ dR+\\int\_{\\Omega\_{1}}u\_{j}(X)\ dR, which implies that

|     |     |     |
| --- | --- | --- |
|  | uj​(R−j,Q~j′′)−uj​(R)=Q~j′​(X+)Qj​(X−)​∫Ω3uj​(X)​d​(R−j,Qj)−∫Ω1uj​(X)​𝑑R.u\_{j}(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})-u\_{j}(R)=\\frac{\\tilde{Q}^{\\prime}\_{j}(X^{+})}{Q\_{j}(X^{-})}\\int\_{\\Omega\_{3}}u\_{j}(X)\ d(R\_{-j},Q\_{j})-\\int\_{\\Omega\_{1}}u\_{j}(X)\ dR. |  |

If MmaxM\_{\\max} is the supremum of uju\_{j} and MminM\_{\\min} is its infimum, we can bound uj​(R−j,Q~j′′)−uj​(R)u\_{j}(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})-u\_{j}(R) by

|     |     |     |
| --- | --- | --- |
|  | uj​(R−j,Q~j′′)−uj​(R)≤Q~j′​(X+)Qj​(X−)​Mmax⋅(R−j,Qj)​(Ω3)−Mmin⋅R⁡(Ω1).u\_{j}(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})-u\_{j}(R)\\leq\\frac{\\tilde{Q}^{\\prime}\_{j}(X^{+})}{Q\_{j}(X^{-})}M\_{\\max}\\cdot(R\_{-j},Q\_{j})(\\Omega\_{3})-M\_{\\min}\\cdot R(\\Omega\_{1}). |  |

Note, however, that (R−j,Qj)​(Ω3)=Qj​(X−)(R\_{-j},Q\_{j})(\\Omega\_{3})=Q\_{j}(X^{-}) and R⁡(Ω1)=Q~j′​(X+)R(\\Omega\_{1})=\\tilde{Q}^{\\prime}\_{j}(X^{+}). Therefore,

|     |     |     |
| --- | --- | --- |
|  | uj​(R−j,Q~j′′)−uj​(R)≤Qj′​(X+)​(Mmax−Mmin),u\_{j}(R\_{-j},\\tilde{Q}^{\\prime\\prime}\_{j})-u\_{j}(R)\\leq Q^{\\prime}\_{j}(X^{+})(M\_{\\max}-M\_{\\min}), |  |

as desired.

Second equation: ℓj​(Q−S,QS∖{j}′,Qj′′)−ℓj​(Q−S,QS′)>Qj′​(X+)⋅M\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j})-\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S})>Q^{\\prime}\_{j}(X^{+})\\cdot M.

The second equation follows from the observation we made in the proof of Proposition [6](https://arxiv.org/html/2312.14745v2#Thmproposition6 "Proposition 6. ‣ 7.2.3 High Level Proof ‣ 7.2 Uncountable Case ‣ 7 Proof of Theorems and , Infinite Case ‣ Strengthening Nash Equilibria"): if (j,X)(j,X) is a maximal bet on jj, then Qj​(X∖X+)=Qj′​(X∖X+)=0Q\_{j}(X\\setminus X^{+})=Q\_{j}^{\\prime}(X\\setminus X^{+})=0. Since Q~j′′​(X+)=0\\tilde{Q}^{\\prime\\prime}\_{j}(X^{+})=0, it follows that ℓj​(Q−S,QS∖{j}′,Qj′′)=0\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S\\setminus\\{j\\}},Q^{\\prime\\prime}\_{j})=0. Thus, it remains to show that ℓj(Q−S,QS′)<−Qj′(X+)⋅M\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S})<-Q^{\\prime}\_{j}(X^{+})\\cdot M. This follows from the same observation since then ℓj​(Q−S,QS′)=𝔼⁡\[\# of other players betting on j\]⋅Qj′​(X+)⋅(−M−1)\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S})=\\mathbb{E}\[\\mbox{\\# of other players betting on j}\]\\cdot Q^{\\prime}\_{j}(X^{+})\\cdot(-M-1). Since we assumed that at least one other player bets on jj in expectation, it follows that ℓj(Q−S,QS′)<−Qj′(X+)⋅M\\ell\_{j}(Q\_{-S},Q^{\\prime}\_{S})<-Q^{\\prime}\_{j}(X^{+})\\cdot M.
∎

## 8 Conclusion and Open Problems

This paper shows that if a mechanism designer has the power to add new actions to a normal-form or Bayesian game, it can shield a given Nash equilibrium from collusion and from equilibrium selection issues. More precisely, given a normal-form (resp., Bayesian) game Γ\\Gamma and a Nash equilibrium σ→\\vec{\\sigma} of Γ\\Gamma, we showed that exists an extension Γσ→\\Gamma^{\\vec{\\sigma}} of Γ\\Gamma such that (a) σ→\\vec{\\sigma} is a semi-strong Nash equilibrium of Γ\\Gamma and (b) σ→\\vec{\\sigma} Pareto-dominates (resp., quasi Pareto-dominates) all other equilibria of Γσ→\\Gamma^{\\vec{\\sigma}}. This result opens the door for three important follow-up problems.

- •


Can we also get Pareto-dominance for arbitrary Bayesian games? We proved that the construction of Γσ→\\Gamma^{\\vec{\\sigma}} given in Section [5.3](https://arxiv.org/html/2312.14745v2#S5.SS3 "5.3 Generalization to Finite Bayesian Games with Independent Types ‣ 5 Proof of Theorem for Finite Games ‣ Strengthening Nash Equilibria") satisfies that σ→\\vec{\\sigma} quasi Pareto-dominates all other Nash equilibria of Γσ→\\Gamma^{\\vec{\\sigma}}. We conjecture that, in fact, σ→\\vec{\\sigma} also Pareto-dominates all other Nash equilibria in this construction.

- •


Minimizing promises. As discussed in earlier sections, we can view the newly added actions in Γσ→\\Gamma^{\\vec{\\sigma}} as _promises_ made by the mechanism designer to the players. In practice, if players are rational and have full information, these newly actions should never be played since every Nash equilibrium that includes them is Pareto-dominated (or quasi Pareto-dominated) by σ→\\vec{\\sigma}. Thus, in theory, the mechanism designer can simply bluff about the existence of these new actions (e.g., by promising to play certain amount to a given player). Nevertheless, it is still an open question to see exactly how much utility must the mechanism designer promise in order to construct a game Γσ→\\Gamma^{\\vec{\\sigma}} that satisfies the properties of Theorem [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria").

- •


Minimum size of Γσ→\\Gamma^{\\vec{\\sigma}}. Theorems [1](https://arxiv.org/html/2312.14745v2#Thmtheorem1 "Theorem 1. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") and [2](https://arxiv.org/html/2312.14745v2#Thmtheorem2 "Theorem 2. ‣ 3 Main Results ‣ Strengthening Nash Equilibria") give upper bounds on the minimum number of actions that must be added in order to construct Γσ→\\Gamma^{\\vec{\\sigma}}. It is still an open problem to verify if there exists a smaller construction.


## References

- \[1\]
Ittai Abraham, Lorenzo Alvisi, and Joseph Y Halpern.

Distributed computing meets game theory: combining insights from two
fields.

Acm Sigact News, 42(2):69–76, 2011.

- \[2\]
Ittai Abraham, Danny Dolev, Ivan Geffner, and Joseph Y Halpern.

Implementing mediators with asynchronous cheap talk.

In Proceedings of the 2019 ACM Symposium on Principles of
Distributed Computing, pages 501–510, 2019.

- \[3\]
Ittai Abraham, Danny Dolev, Rica Gonen, and Joseph Y Halpern.

Distributed computing meets game theory: robust mechanisms for
rational secret sharing and multiparty computation.

In Proceedings of the twenty-fifth annual ACM symposium on
Principles of distributed computing, pages 53–62, 2006.

- \[4\]
Ittai Abraham, Danny Dolev, and Joseph Y Halpern.

Lower bounds on implementing robust and resilient mediators.

In Theory of Cryptography: Fifth Theory of Cryptography
Conference, TCC 2008, New York, USA, March 19-21, 2008. Proceedings 5, pages
302–319. Springer, 2008.

- \[5\]
Amitanand S Aiyer, Lorenzo Alvisi, Allen Clement, Mike Dahlin, Jean-Philippe
Martin, and Carl Porth.

Bar fault tolerance for cooperative services.

In Proceedings of the twentieth ACM symposium on Operating
systems principles, pages 45–58, 2005.

- \[6\]
Robert J Aumann.

Acceptable points in general cooperative n-person games.

Contributions to the Theory of Games, 4:287–324, 1959.

- \[7\]
Robert J Aumann.

Subjectivity and correlation in randomized strategies.

Journal of mathematical Economics, 1(1):67–96, 1974.

- \[8\]
M. Ben-Or, S. Goldwasser, and A. Wigderson.

Completeness theorems for non-cryptographic fault-tolerant
distributed computation.

In Proceedings of the 20th ACM Symposium on Theory of
Computing, pages 1–10, 1988.

- \[9\]
Michael Ben-Or.

Another advantage of free choice (extended abstract) completely
asynchronous agreement protocols.

In Proceedings of the second annual ACM symposium on Principles
of distributed computing, pages 27–30, 1983.

- \[10\]
Michael Ben-Or, Ran Canetti, and Oded Goldreich.

Asynchronous secure computation.

In Proceedings of the twenty-fifth annual ACM symposium on
Theory of computing, pages 52–61, 1993.

- \[11\]
B Douglas Bernheim, Bezalel Peleg, and Michael D Whinston.

Coalition-proof nash equilibria i. concepts.

Journal of economic theory, 42(1):1–12, 1987.

- \[12\]
Gabriel Bracha.

An asynchronous \[(n-1)/3\]-resilient consensus protocol.

In Proceedings of the third annual ACM symposium on Principles
of distributed computing, pages 154–162, 1984.

- \[13\]
Gabriel Bracha and Sam Toueg.

Asynchronous consensus and broadcast protocols.

Journal of the ACM (JACM), 32(4):824–840, 1985.

- \[14\]
Francoise Forges.

An approach to communication equilibria.

Econometrica: Journal of the Econometric Society, pages
1375–1385, 1986.

- \[15\]
Ivan Geffner and Joseph Y Halpern.

Security in asynchronous interactive systems.

In International Symposium on Stabilizing, Safety, and Security
of Distributed Systems, pages 123–140. Springer, 2021.

- \[16\]
Ivan Geffner and Joseph Y Halpern.

Communication games, sequential equilibrium, and mediators.

arXiv preprint, arXiv:2309.14618, 2023.

- \[17\]
Ivan Geffner and Joseph Y Halpern.

Lower bounds on implementing mediators in asynchronous systems with
rational and malicious agents.

Journal of the ACM, 70(2):1–21, 2023.

- \[18\]
Dov Monderer and Moshe Tennenholtz.

k-implementation.

In Proceedings of the 4th ACM conference on Electronic
Commerce, pages 19–28, 2003.

- \[19\]
Dov Monderer and Moshe Tennenholtz.

Strong mediated equilibrium.

Artificial Intelligence, 173(1):180–195, 2009.

- \[20\]
Caspar Oesterheld, Johannes Treutlein, Roger Grosse, Vincent Conitzer, and
Jakob Foerster.

Similarity-based cooperation.

arXiv preprint, arXiv:2211.14468, 2022.

- \[21\]
Michal Penn, Maria Polukarov, and Moshe Tennenholtz.

Congestion games with failures.

In Proceedings of the 6th ACM Conference on Electronic
Commerce, pages 259–268, 2005.

- \[22\]
Michael O Rabin.

Randomized byzantine generals.

In 24th annual symposium on foundations of computer science
(sfcs 1983), pages 403–409. IEEE, 1983.

- \[23\]
Alejandro Ranchal-Pedrosa and Vincent Gramoli.

Rational agreement in the presence of crash faults.

In 2021 IEEE International Conference on Blockchain, pages
470–475. IEEE, 2021.

- \[24\]
Moshe Tennenholtz.

Program equilibrium.

Games and Economic Behavior, 49(2):363–373, 2004.

- \[25\]
Xavier Vilaça, Joao Leitao, Miguel Correia, and Luís Rodrigues.

N-party bar transfer.

In Proceedings of the 2011 Conference on Principles of
Distributed Systems, pages 392–408. Springer, 2011.

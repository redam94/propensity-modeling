"""Synthetic, realistic brand-lift survey data with confounded exposure.

Exposure (``group`` = "Exposed"/"Control", ~40% exposed) depends on age,
gender, region, income, media usage, prior brand usage, device and ad
blocking. The same factors drive the KPIs, so raw exposed-vs-control
differences overstate the true effect. True exposure effects (latent scale):

* aided_awareness   +0.45 log-odds
* unaided_awareness  0 (NO effect: any raw lift is pure confounding)
* favorability      +0.25 on the latent 1-5 scale
* consideration     +0.35 log-odds
* purchase_intent   +0.30 latent (ordered logit)
* ad_recall         +0.90 log-odds
"""

from __future__ import annotations

import numpy as np
import pandas as pd

TRUE_EFFECTS = {
    "aided_awareness": 0.45,
    "unaided_awareness": 0.0,
    "favorability": 0.25,
    "consideration": 0.35,
    "purchase_intent": 0.30,
    "ad_recall": 0.90,
}

PURCHASE_INTENT_LEVELS = [
    "Definitely will not",
    "Probably will not",
    "Might or might not",
    "Probably will",
    "Definitely will",
]

_ADJ = ["Last", "Hidden", "Golden", "Silent", "Broken", "Wild", "Lost", "Bright", "Dark", "Young", "Old", "Red",
        "Blue", "Secret", "Final", "Little", "Big", "Crazy", "Royal", "Modern", "Lucky", "Strange", "Iron", "Paper"]
_NOUN = ["Kingdom", "Detective", "Kitchen", "Island", "Office", "Doctors", "Family", "Empire", "Game", "Show",
         "House", "Road", "City", "Witness", "Agents", "Chef", "Files", "Friends", "Hospital", "Ranch", "Club",
         "Station", "Garden", "Lawyers", "Brothers", "Sisters", "Wars", "Code", "Hotel", "Diaries", "Academy"]


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _std(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / (x.std() + 1e-12)


def _likert(rng: np.random.Generator, latent: np.ndarray, cuts=(-1.5, -0.5, 0.5, 1.5)) -> np.ndarray:
    return (np.searchsorted(np.asarray(cuts), latent + rng.normal(0, 0.8, latent.size)) + 1).astype(float)


def _with_missing(rng: np.random.Generator, x: np.ndarray, rate: float) -> np.ndarray:
    x = x.astype(object) if x.dtype.kind in "OUS" else x.astype(float)
    m = rng.random(x.size) < rate
    x[m] = None if x.dtype == object else np.nan
    return x


def make_brand_lift_sample(n: int = 3000, seed: int = 0) -> pd.DataFrame:
    """Generate a respondent-level brand-lift survey dataset (one row per respondent)."""
    rng = np.random.default_rng(seed)

    # ---- demographics ----------------------------------------------------- #
    age = np.clip(np.round(18 + 57 * rng.beta(1.6, 2.0, n)), 18, 75).astype(int)
    age_band = pd.cut(age, [17, 24, 34, 44, 54, 120], labels=["18-24", "25-34", "35-44", "45-54", "55+"])
    age_band = np.asarray(age_band.astype(str))
    gender = rng.choice(["Female", "Male", "Non-binary"], n, p=[0.5, 0.47, 0.03])
    region = rng.choice(["Northeast", "Midwest", "South", "West"], n, p=[0.18, 0.21, 0.38, 0.23])
    educ_lat = rng.normal(0, 1, n) + 0.01 * (age - 40)
    education = np.select(
        [educ_lat < -0.9, educ_lat < 0.0, educ_lat < 0.9],
        ["High school or less", "Some college", "Bachelor's degree"], "Graduate degree",
    )
    income_k = np.exp(np.log(62) + 0.25 * educ_lat + 0.012 * (np.minimum(age, 55) - 35) + rng.normal(0, 0.45, n))
    income_k = np.clip(np.round(income_k, 1), 10, 400)
    income_obs = _with_missing(rng, income_k, 0.06)
    income_band = np.select(
        [income_k < 35, income_k < 75, income_k < 125], ["<$35k", "$35-75k", "$75-125k"], "$125k+"
    ).astype(object)
    income_band[np.isnan(income_obs)] = "Prefer not to say"
    employment = np.where(age >= 66, "Retired",
                          rng.choice(["Full-time", "Part-time", "Unemployed", "Student", "Homemaker"], n,
                                     p=[0.58, 0.15, 0.07, 0.10, 0.10]))
    employment = np.where((age < 23) & (rng.random(n) < 0.5), "Student", employment)
    marital_status = rng.choice(["Married", "Single", "Divorced", "Widowed", "Partnered"], n,
                                p=[0.45, 0.32, 0.1, 0.04, 0.09])
    household_size = np.clip(rng.poisson(1.6, n) + 1, 1, 8)
    children_in_household = np.where(rng.random(n) < _sigmoid(-0.8 + 0.5 * (household_size - 2)), "Yes", "No")
    urb_p = {"Northeast": [0.5, 0.35, 0.15], "Midwest": [0.3, 0.4, 0.3], "South": [0.3, 0.4, 0.3],
             "West": [0.5, 0.35, 0.15]}
    urbanicity = np.array([rng.choice(["Urban", "Suburban", "Rural"], p=urb_p[r]) for r in region])
    ethnicity = rng.choice(["White", "Hispanic", "Black", "Asian", "Other"], n, p=[0.6, 0.18, 0.12, 0.06, 0.04])

    # ---- media habits ----------------------------------------------------- #
    youth = _std(-age.astype(float))
    tv_hours_week = np.round(rng.gamma(2.0, 6.0, n) * np.exp(-0.25 * youth), 1)
    social_media_hours_day = np.round(rng.gamma(2.0, 0.9, n) * np.exp(0.35 * youth), 1)
    streaming_hours_week = np.round(rng.gamma(2.2, 4.0, n) * np.exp(0.2 * youth), 1)
    radio_hours_week = np.round(rng.gamma(1.5, 3.0, n), 1)
    podcast_listener = np.where(rng.random(n) < _sigmoid(-0.4 + 0.5 * youth), "Yes", "No")
    dev_lat = youth + rng.normal(0, 1, n)
    primary_device = np.select(
        [dev_lat > 0.3, dev_lat > -0.4, dev_lat > -1.0], ["Mobile", "Connected TV", "Desktop"], "Tablet"
    )
    ad_blocker = np.where(rng.random(n) < _sigmoid(-1.3 + 0.4 * youth), "Yes", "No")
    social_platforms_used = np.clip(np.round(2.5 + 1.2 * youth + rng.normal(0, 1.3, n)), 0, 8).astype(int)
    news_sites_visited_week = rng.poisson(4, n)
    gaming_hours_week = np.round(rng.gamma(1.0, 3.0, n) * np.exp(0.4 * youth), 1)
    media_std = _std(np.log1p(social_media_hours_day * 7 + streaming_hours_week))

    # ---- brand relationship & psychographics ----------------------------- #
    use_lat = 0.3 * _std(np.log(income_k)) + 0.2 * _std(age.astype(float)) + rng.normal(0, 1, n)
    prior_brand_usage = np.select([use_lat > 0.8, use_lat > 0.0], ["Current user", "Lapsed user"], "Never used")
    current = (prior_brand_usage == "Current user").astype(float)
    lapsed = (prior_brand_usage == "Lapsed user").astype(float)
    category_purchase_freq = rng.choice(["Weekly", "Monthly", "Quarterly", "Rarely"], n, p=[0.2, 0.4, 0.25, 0.15])
    brand_loyalty_score = np.clip(np.round(5 + 1.5 * current + rng.normal(0, 2, n)), 0, 10).astype(int)

    att_names = [
        "att_early_adopter", "att_price_conscious", "att_brand_loyal", "att_eco_conscious",
        "att_health_focused", "att_ads_informative", "att_social_influence", "att_quality_over_price",
        "att_impulse_buyer", "att_research_before_buy", "att_trust_big_brands", "att_enjoy_shopping",
    ]
    att_lat = {
        "att_early_adopter": 0.5 * youth,
        "att_price_conscious": -0.4 * _std(np.log(income_k)),
        "att_brand_loyal": 0.6 * current,
        "att_ads_informative": 0.2 * media_std,
        "att_social_influence": 0.5 * youth,
    }
    atts = {a: _with_missing(rng, _likert(rng, att_lat.get(a, np.zeros(n))), 0.03) for a in att_names}

    # ---- noise / admin columns ------------------------------------------- #
    shows = np.array([f"The {a} {b}" for a in _ADJ for b in _NOUN])
    favorite_tv_show = rng.choice(shows, n).astype(object)
    favorite_tv_show[rng.random(n) < 0.1] = None
    zip_code = np.array([f"{z:05d}" for z in rng.integers(1000, 99950, n)])
    survey_date = pd.Timestamp("2026-03-01") + pd.to_timedelta(rng.integers(0, 28 * 24 * 60, n), unit="m")
    completion_minutes = np.round(rng.lognormal(np.log(12), 0.35, n), 1)
    panel_source = rng.choice(["Panel A", "Panel B", "Panel C", "River"], n, p=[0.4, 0.3, 0.2, 0.1])

    # ---- exposure (confounded) -------------------------------------------- #
    reg_eff = {"Northeast": 0.2, "Midwest": -0.15, "South": 0.0, "West": 0.25}
    dev_eff = {"Mobile": 0.3, "Connected TV": 0.35, "Desktop": 0.0, "Tablet": 0.1}
    z = (
        -0.025 * (age - 40)
        + 0.15 * (gender == "Male")
        + np.array([reg_eff[r] for r in region])
        + 0.3 * np.log(income_k / 62)
        + 0.45 * media_std
        + 0.8 * current + 0.3 * lapsed
        + np.array([dev_eff[d] for d in primary_device])
        - 0.4 * (ad_blocker == "Yes")
    )
    lo, hi = -5.0, 5.0
    for _ in range(60):  # calibrate intercept to ~40% exposed
        mid = (lo + hi) / 2
        if _sigmoid(mid + z).mean() < 0.40:
            lo = mid
        else:
            hi = mid
    exposed = rng.random(n) < _sigmoid((lo + hi) / 2 + z)
    ex = exposed.astype(float)

    # ---- outcomes ----------------------------------------------------------- #
    conf = (
        1.0 * current + 0.4 * lapsed + 0.3 * media_std + 0.2 * np.log(income_k / 62)
        - 0.012 * (age - 40) + 0.15 * _std(_likert(rng, 0.6 * current))
    )
    eff = TRUE_EFFECTS
    aided = rng.random(n) < _sigmoid(-0.1 + conf + eff["aided_awareness"] * ex)
    unaided = rng.random(n) < _sigmoid(-1.4 + conf + eff["unaided_awareness"] * ex)
    fav_lat = 3.0 + 0.6 * conf + eff["favorability"] * ex + rng.normal(0, 0.9, n)
    favorability = np.clip(np.round(fav_lat), 1, 5)
    favorability = _with_missing(rng, favorability, 0.02)
    consideration = rng.random(n) < _sigmoid(-0.8 + conf + eff["consideration"] * ex)
    pi_lat = 0.9 * conf + eff["purchase_intent"] * ex + rng.logistic(0, 1, n)
    pi_idx = np.searchsorted(np.array([-1.6, -0.5, 0.6, 1.8]), pi_lat)
    purchase_intent = np.array(PURCHASE_INTENT_LEVELS, dtype=object)[pi_idx]
    ad_recall = rng.random(n) < _sigmoid(-1.6 + 0.4 * media_std + 0.2 * conf + eff["ad_recall"] * ex)

    df = pd.DataFrame({
        "respondent_id": [f"R{i:06d}" for i in range(1, n + 1)],
        "group": np.where(exposed, "Exposed", "Control"),
        "age": age,
        "age_band": age_band,
        "gender": gender,
        "region": region,
        "household_income_k": income_obs,
        "income_band": income_band,
        "education": education,
        "employment": employment,
        "marital_status": marital_status,
        "household_size": household_size,
        "children_in_household": children_in_household,
        "urbanicity": urbanicity,
        "ethnicity": ethnicity,
        "tv_hours_week": _with_missing(rng, tv_hours_week, 0.04),
        "social_media_hours_day": social_media_hours_day,
        "streaming_hours_week": streaming_hours_week,
        "radio_hours_week": radio_hours_week,
        "podcast_listener": podcast_listener,
        "primary_device": primary_device,
        "ad_blocker": ad_blocker,
        "social_platforms_used": social_platforms_used,
        "news_sites_visited_week": news_sites_visited_week,
        "gaming_hours_week": gaming_hours_week,
        "prior_brand_usage": prior_brand_usage,
        "category_purchase_freq": category_purchase_freq,
        "brand_loyalty_score": brand_loyalty_score,
        **atts,
        "favorite_tv_show": favorite_tv_show,
        "zip_code": zip_code,
        "survey_date": survey_date,
        "completion_minutes": completion_minutes,
        "panel_source": panel_source,
        "aided_awareness": np.where(aided, "Yes", "No"),
        "unaided_awareness": unaided.astype(int),
        "favorability": favorability,
        "consideration": np.where(consideration, "Yes", "No"),
        "purchase_intent": purchase_intent,
        "ad_recall": ad_recall.astype(int),
    })
    return df


SAMPLE_MODEL_FEATURES = [
    "age", "income_band", "education", "employment", "marital_status", "household_size",
    "children_in_household", "urbanicity", "ethnicity", "tv_hours_week", "social_media_hours_day",
    "streaming_hours_week", "radio_hours_week", "podcast_listener", "primary_device", "ad_blocker",
    "social_platforms_used", "prior_brand_usage", "category_purchase_freq", "household_income_k",
]
SAMPLE_MATCHING_FEATURES = ["age_band", "gender", "region"]
SAMPLE_OUTCOMES = list(TRUE_EFFECTS)
SAMPLE_TOP2_BOX = {"purchase_intent": ["Definitely will", "Probably will"]}


def sample_analysis_config(dataset_id: str = "sample", **overrides):
    """An AnalysisConfig suited to :func:`make_brand_lift_sample` data (handy for demos/tests)."""
    from .schemas import AnalysisConfig

    base = dict(
        dataset_id=dataset_id,
        treatment_column="group",
        exposed_values=["Exposed"],
        control_values=["Control"],
        outcome_columns=list(SAMPLE_OUTCOMES),
        outcome_positive_values=dict(SAMPLE_TOP2_BOX),
        model_features=list(SAMPLE_MODEL_FEATURES),
        matching_features=list(SAMPLE_MATCHING_FEATURES),
        subgroup_columns=["gender"],
        methods=["nn_matching", "ipw", "overlap_weights", "stratification"],
        n_bootstrap=200,
    )
    base.update(overrides)
    return AnalysisConfig(**base)

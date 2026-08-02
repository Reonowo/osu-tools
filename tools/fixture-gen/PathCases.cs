namespace FixtureGen;

public record Cp(float X, float Y, string? Type = null, int? Degree = null);

public record ApproximatorCase(string Name, Cp[] Points, int? Degree = null);

public record SliderPathCase(
    string Name,
    Cp[] Points,
    double? ExpectedDistance = null,
    bool OptimiseCatmull = true);

public static class PathCases
{
    // degree null = call BezierToPiecewiseLinear; degree set = BSplineToPiecewiseLinear
    public static readonly ApproximatorCase[] Bsplines =
    {
        new("bezier-two-point", new Cp[] { new(0, 0), new(100, 50) }),
        new("bezier-quadratic", new Cp[] { new(0, 0), new(100, 100), new(200, 0) }),
        new("bezier-cubic", new Cp[] { new(0, 0), new(50, 120), new(150, 120), new(200, 0) }),
        new("bezier-single-point", new Cp[] { new(42, 24) }),
        new("bezier-duplicate-interior", new Cp[] { new(0, 0), new(80, 80), new(80, 80), new(160, 0) }),
        new("bezier-many-points", new Cp[]
        {
            new(0, 0), new(20, 90), new(40, -30), new(60, 110), new(80, -50),
            new(100, 130), new(120, -70), new(140, 150), new(160, -90), new(180, 170),
            new(200, -110), new(220, 190), new(240, -130), new(260, 210), new(280, 0),
            new(300, 60),
        }),
        new("bspline-degree-2", new Cp[]
        {
            new(0, 0), new(60, 120), new(120, -40), new(180, 140), new(240, 0), new(300, 80),
        }, Degree: 2),
        new("bspline-degree-3", new Cp[]
        {
            new(0, 0), new(60, 120), new(120, -40), new(180, 140), new(240, 0), new(300, 80),
        }, Degree: 3),
        new("bspline-degree-exceeds-points", new Cp[] { new(0, 0), new(100, 100), new(200, 0) }, Degree: 7),
    };

    public static readonly ApproximatorCase[] Catmulls =
    {
        new("catmull-two-point", new Cp[] { new(0, 0), new(100, 60) }),
        new("catmull-simple", new Cp[] { new(0, 0), new(80, 100), new(160, -20), new(240, 60) }),
        new("catmull-stacked-knots", new Cp[] { new(50, 50), new(50, 50), new(150, 50), new(150, 50) }),
        new("catmull-sharp-turns", new Cp[] { new(0, 0), new(200, 0), new(0, 10), new(200, 10) }),
    };

    public static readonly ApproximatorCase[] Linears =
    {
        new("linear-two-point", new Cp[] { new(0, 0), new(100, 0) }),
        new("linear-multi", new Cp[] { new(0, 0), new(50, 50), new(50, 50), new(120, 0) }),
    };

    // exactly three points each; sliderpathcase-level guards come in task 9
    public static readonly ApproximatorCase[] Arcs =
    {
        new("arc-semicircle", new Cp[] { new(0, 0), new(100, 100), new(200, 0) }),
        new("arc-minor", new Cp[] { new(0, 0), new(60, 20), new(120, 0) }),
        new("arc-major-wrap", new Cp[] { new(0, 0), new(0, 200), new(-10, 0.25f) }),
        new("arc-collinear-fallback", new Cp[] { new(0, 0), new(100, 0), new(200, 0) }),
        // is_valid (cross = 0.002 > FLOAT_EPSILON); named for what actually makes
        // it interesting: the huge circumradius drives 1 - tolerance/radius to
        // exactly 1.0f, so acos(1.0) = 0 and the point-count division explodes to
        // +infinity — see CircularArcProperties.cs and PathApproximator.cs:186
        new("arc-huge-radius-zero-acos", new Cp[] { new(0, 0), new(100, 0.00001f), new(200, 0) }),
        new("arc-tiny-radius", new Cp[] { new(0, 0), new(0.02f, 0.02f), new(0.04f, 0) }),
        // is_valid with a genuinely small circumradius (~0.04): exercises
        // PathApproximator.cs:186's `2 * radius <= circular_arc_tolerance ? 2 : ...`
        // special case directly, as opposed to arc-tiny-radius above (which is
        // caught by the degenerate-triangle check instead and never reaches this
        // branch). near-equilateral so the triangle area clears FLOAT_EPSILON with
        // a comfortable margin (cross ~= 0.00415, over 4x the 0.001 threshold)
        new("arc-radius-under-tolerance", new Cp[] { new(0, 0.04f), new(-0.03464f, -0.02f), new(0.03464f, -0.02f) }),
        new("arc-clockwise", new Cp[] { new(0, 0), new(100, -100), new(200, 0) }),
    };

    public static readonly SliderPathCase[] SliderPaths =
    {
        new("single-bezier", new Cp[] { new(0, 0, "Bezier"), new(100, 100), new(200, 0) }),
        new("first-point-null-type-defaults-linear", new Cp[] { new(0, 0), new(100, 0), new(100, 100) }),
        new("multi-segment-bezier", new Cp[]
        {
            new(0, 0, "Bezier"), new(80, 120), new(160, 0, "Bezier"), new(240, -120), new(320, 0),
        }),
        new("mixed-linear-perfect-bezier", new Cp[]
        {
            new(0, 0, "Linear"), new(100, 0, "PerfectCurve"), new(150, 50), new(200, 0, "Bezier"),
            new(250, 100), new(300, 0),
        }),
        new("duplicate-joint-dedup", new Cp[]
        {
            new(0, 0, "Linear"), new(100, 0, "Linear"), new(100, 0), new(100, 100),
        }),
        new("perfect-simple", new Cp[] { new(0, 0, "PerfectCurve"), new(100, 100), new(200, 0) }),
        new("perfect-four-points-degrades", new Cp[]
        {
            new(0, 0, "PerfectCurve"), new(60, 80), new(120, 80), new(180, 0),
        }),
        new("perfect-collinear-degrades", new Cp[] { new(0, 0, "PerfectCurve"), new(100, 0), new(200, 0) }),
        new("perfect-subdivision-guard", new Cp[]
        {
            new(0, 0, "PerfectCurve"), new(0, 50000), new(-10, 0.002f),
        }),
        // the counterpart to perfect-subdivision-guard: a circumradius large enough
        // (~4.7e6) that 1f - 0.1f/radius rounds to exactly 1.0f, so Acos returns 0
        // and SliderPath.cs:355's division explodes to +infinity. on the pinned
        // .NET 8 x86/x64 runtime the unchecked (int) cast of that yields
        // int.MinValue, Math.Max(2, ...) clamps it back to 2, and the `>= 1000`
        // guard is FALSE -- so lazer takes the circular-arc branch and emits 2
        // vertices. a port that saturates the cast instead would take the b-spline
        // branch and emit ~129 vertices, which this case pins against.
        // playfield-range coordinates, i.e. a shape a mapper can actually produce
        new("perfect-huge-radius-takes-arc", new Cp[]
        {
            new(175, 121, "PerfectCurve"), new(44, 32), new(465, 318),
        }),
        new("catmull-with-bulb-culling", new Cp[]
        {
            new(50, 50, "Catmull"), new(50, 50), new(150, 50), new(150, 50),
        }),
        new("catmull-without-culling", new Cp[]
        {
            new(50, 50, "Catmull"), new(50, 50), new(150, 50), new(150, 50),
        }, OptimiseCatmull: false),
        new("bspline-degree-2-segment", new Cp[]
        {
            new(0, 0, "BSpline", 2), new(60, 120), new(120, -40), new(180, 140), new(240, 0),
        }),
        new("expected-shorten", new Cp[] { new(0, 0, "Linear"), new(200, 0) }, ExpectedDistance: 120),
        new("expected-shorten-past-vertices", new Cp[]
        {
            new(0, 0, "Linear"), new(50, 0), new(100, 0), new(150, 0), new(200, 0),
        }, ExpectedDistance: 60),
        new("expected-extend", new Cp[] { new(0, 0, "Linear"), new(100, 0) }, ExpectedDistance: 180),
        new("expected-extend-skipped-identical-tail", new Cp[]
        {
            new(0, 0, "Linear"), new(100, 0), new(100, 0),
        }, ExpectedDistance: 200),
        new("expected-zero", new Cp[] { new(0, 0, "Linear"), new(100, 0) }, ExpectedDistance: 0),
        new("zero-length-all-identical", new Cp[] { new(77, 77, "Bezier"), new(77, 77), new(77, 77) }),
    };
}

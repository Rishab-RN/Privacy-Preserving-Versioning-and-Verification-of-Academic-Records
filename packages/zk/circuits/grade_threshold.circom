pragma circom 2.2.0;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

// Fixed-point hundredths, not floating-point GPA. Every secret is constrained.
template GradeThreshold() {
    signal input grade;
    signal input salt;
    signal input secret;
    signal input commitment;
    signal input context;
    signal input holder;
    signal input maximum;
    signal input threshold;
    signal input challenge;
    signal output nullifier;

    component gradeBits = Num2Bits(14); gradeBits.in <== grade;
    component maxBits = Num2Bits(14); maxBits.in <== maximum;
    component thresholdBits = Num2Bits(14); thresholdBits.in <== threshold;
    component saltBits = Num2Bits(248); saltBits.in <== salt;
    component secretBits = Num2Bits(248); secretBits.in <== secret;
    component maxBound = LessEqThan(14);
    maxBound.in[0] <== maximum; maxBound.in[1] <== 9999; maxBound.out === 1;
    component gradeBound = LessEqThan(14);
    gradeBound.in[0] <== grade; gradeBound.in[1] <== maximum; gradeBound.out === 1;
    component eligible = LessEqThan(14);
    eligible.in[0] <== threshold; eligible.in[1] <== grade; eligible.out === 1;
    component owner = Poseidon(2);
    owner.inputs[0] <== 2026112501; owner.inputs[1] <== secret;
    owner.out === holder;
    component committed = Poseidon(6);
    committed.inputs[0] <== 2026112502; committed.inputs[1] <== grade;
    committed.inputs[2] <== salt; committed.inputs[3] <== context;
    committed.inputs[4] <== holder; committed.inputs[5] <== maximum;
    committed.out === commitment;
    component bound = Poseidon(4);
    bound.inputs[0] <== 2026112503; bound.inputs[1] <== secret;
    bound.inputs[2] <== challenge; bound.inputs[3] <== context;
    nullifier <== bound.out;
}
component main {public [commitment, context, holder, maximum, threshold, challenge]} = GradeThreshold();

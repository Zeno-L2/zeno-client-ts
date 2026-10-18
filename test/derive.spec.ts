import { expect } from "chai";
import { Address, Hash } from "znn-typescript-sdk";
import {
    chainId,
    contractId,
    l1Caller,
    sha3,
    smtKey,
} from "../src/index.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("settlement derivations", () => {
    it("uses SHA3-256, not Keccak-256", () => {
        expect(hex(sha3())).to.equal("a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
    });

    // Vectors produced by zeno-executor's callerHash, contractID and derive
    // over the same inputs.
    const deployer = Address.parse("z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp");

    it("derives chain_id", () => {
        expect(chainId("testnet").toString())
            .to.equal("2ec4956003e8ee66d5b7776357eedc548c1410231e64cf072db91a46aa667ab9");
    });

    it("derives the L1 caller", () => {
        expect(l1Caller(deployer).toString())
            .to.equal("34a3e5bcd2ab10f20b7e8ae143d9b1daa597204596d97a4211d572bc0b3c8c8d");
    });

    it("derives the ContractID", () => {
        expect(contractId(deployer, 12345n, chainId("testnet")).toString())
            .to.equal("d384cf7c54a8a3e8eddac2babfe1eecd569144c703c702c3c1525f166810c437");
    });

    it("derives the SMT key", () => {
        const id = Hash.parse("d384cf7c54a8a3e8eddac2babfe1eecd569144c703c702c3c1525f166810c437");
        expect(smtKey(id, Uint8Array.of(0x00, 0x01)).toString())
            .to.equal("41636e61f096f0cf84b5b37c29b3ce44d695864e174a85de3f90022fabb94580");
    });
});

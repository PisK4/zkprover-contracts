import { ethers } from 'hardhat'
import {
	EntryPoint,
	EntryPoint__factory,
	AccountFactory,
	Account,
	Account__factory,
	TestToken__factory,
	TestToken,
	ZkProverZkpVerifierWrapper,
	ZkProverZkpVerifierWrapper__factory,
    VerifyingPaymaster,
    VerifyingPaymaster__factory,
} from '../typechain-types'
import {
	AddressZero,
	createAccountOwner,
	createAddress,
	simulationResultCatch,
    MOCK_VALID_UNTIL,
    MOCK_VALID_AFTER,
	checkForBannedOps,
	generateBatchofERC20TransferOp
} from './testutils'
import { Wallet } from 'ethers'
import { expect } from 'chai'
import { fillAndSign } from './UserOp'
import { arrayify, hexConcat } from '@ethersproject/bytes'
import { defaultAbiCoder } from 'ethers/lib/utils'
import { compile_yul, halo2zkpVerifierAbi } from '../scripts/utils'
import { UserOperationStruct } from '../typechain-types/contracts/Account'
const notFund = true

describe('3.simulateValidation.test', () => {
	let entryPoint: EntryPoint
	let entryPointzkp: EntryPoint
	let verifier: ZkProverZkpVerifierWrapper
    let paymaster: VerifyingPaymaster
	const ethersSigners = ethers.provider.getSigner()
    const ethersSignerAdmin = ethers.provider.getSigner(1)
	let accountOwner: Wallet
	let refundAccount: Wallet
	let account: Account
	let token: TestToken
	let beneficiaryAddress: string


	before(async () => {
		accountOwner = createAccountOwner()
		beneficiaryAddress = createAddress()
		refundAccount = createAccountOwner()

		entryPointzkp = await new EntryPoint__factory(ethersSigners).deploy(
			AddressZero
		)
		let verifyCode = await compile_yul("contracts/zkp/zkpVerifier.yul");

		const factory = new ethers.ContractFactory(
			halo2zkpVerifierAbi,
			verifyCode,
			ethersSigners
		  );
		  const verifyContract = await factory.deploy();
		verifier = await new ZkProverZkpVerifierWrapper__factory(
			ethersSigners
		  ).deploy(verifyContract.address);
		entryPoint = await new EntryPoint__factory(ethersSigners).deploy(verifier.address)

		account = await new Account__factory(ethersSigners).deploy(
			entryPoint.address
		)
        token = await new TestToken__factory(ethersSigners).deploy()
        paymaster = await new VerifyingPaymaster__factory(ethersSigners).deploy(
            entryPoint.address,
            await ethersSigners.getAddress())
		console.log('entryPoint', entryPoint.address)
    })

	it('simulate transfer ERC20 with PayMaster', async () => {
		await paymaster.deposit({ value: ethers.utils.parseEther('1') })
		const { op, accountOwner, accountFactory } =
		await generateBatchofERC20TransferOp(
			ethersSigners,
			token,
			entryPoint,
			account,
			1,
			paymaster,
			ethersSigners,
			undefined,
			undefined,
			notFund
		)
		// ops.push(op)

		const res = await entryPoint.callStatic
			.simulateValidation(op)
			.catch(simulationResultCatch)
		// expect(res.returnInfo.sigFailed).to.be.false
		expect(res.returnInfo.validAfter).to.be.equal(
			ethers.BigNumber.from(MOCK_VALID_AFTER)
		)
		expect(res.returnInfo.validUntil).to.be.equal(
			ethers.BigNumber.from(MOCK_VALID_UNTIL)
		)

		await entryPoint
        .simulateValidation(op, { gasLimit: 10e6 })
        .catch((e) => e)
		const block = await ethers.provider.getBlock('latest')
		const hashop = block.transactions[0]
		await checkForBannedOps(hashop, false)
	})    
})